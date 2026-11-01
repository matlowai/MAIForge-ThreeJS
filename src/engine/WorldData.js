import { NativeRegion } from './NativeRegion.js';
import { NativeProxy } from './NativeProxy.js';
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const modulo = (x, n) => ((x % n) + n) % n;
const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])) : v;
const canonical = v => JSON.stringify(ordered(v));
const required = ['elevation', 'surfaceHeight', 'lithology', 'waterKind'];
const roleTypes = {elevation:'f32le',surfaceHeight:'f32le',lithology:'u8',waterKind:'u8',temperature:'f32le',precipitation:'f32le'};
function validate(m){
 const {rows,cols}=m?.grid??{};
 if(m?.schema!=='maiforge.viewer-world/v1'||!Number.isInteger(rows)||!Number.isInteger(cols)||rows<4||cols<4||rows*cols>4194304)throw Error('Unsupported world grid.');
 if(typeof m.id!=='string'||!m.id.trim()||m.id.length>256||!Number.isFinite(m.sourceResolutionM)||m.sourceResolutionM<=0)throw Error('Invalid source identity/resolution.');
 for(const key of required)if(!m.fields?.[key])throw Error('Missing required source role: '+key);
 for(const [key,f] of Object.entries(m.fields??{})){if(!roleTypes[key]||f.type!==roleTypes[key])throw Error('Invalid source role encoding: '+key);if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.file)||f.bytes!==rows*cols*(f.type==='u8'?1:4)||!/^[0-9a-f]{64}$/.test(f.sha256))throw Error('Invalid field descriptor: '+key);}
}

/** Immutable native overview data. Interpolation is a rendering representation,
 * not a replacement for core simulation, collision or finite-material queries. */
export class WorldData {
  static async load(url, { onProgress = () => {}, fetchImpl = fetch } = {}) {
    const base = new URL(url, globalThis.location?.href ?? 'http://localhost/');
    const response = await fetchImpl(base, { credentials: 'omit' });
    if (!response.ok) throw new Error(`World manifest request failed (${response.status}).`);
    const manifest = await response.json();
    validate(manifest);
    const { rows, cols } = manifest.grid ?? {};
    if (manifest.schema !== 'maiforge.viewer-world/v1' || !Number.isInteger(rows) || !Number.isInteger(cols)
        || rows < 4 || cols < 4 || rows * cols > 4_194_304) throw new Error('Unsupported or oversized world manifest.');
    const buffers = {};
    const entries = Object.entries(manifest.fields ?? {});
    let done = 0;
    await Promise.all(entries.map(async ([key, field]) => {
      if (!/^[a-zA-Z0-9_.-]+$/.test(field.file)) throw new Error('World field must use a local filename.');
      const width = field.type === 'f32le' ? 4 : field.type === 'u8' ? 1 : 0;
      if (!width || field.bytes !== rows * cols * width) throw new Error(`Invalid ${key} field shape.`);
      const r = await fetchImpl(new URL(field.file, base), { credentials: 'omit', cache: 'force-cache' });
      if (!r.ok) throw new Error(`World field ${key} failed (${r.status}).`);
      const b = await r.arrayBuffer();
      if (b.byteLength !== field.bytes) throw new Error(`Truncated world field ${key}.`);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), v => v.toString(16).padStart(2, '0')).join('');
      if (hash !== field.sha256) throw new Error(`World field ${key} failed its source hash.`);
      buffers[key] = b;
      onProgress(++done / entries.length);
    }));
    let nativeRegion=null,nativeProxy=null;
    if(manifest.nativeRegion || manifest.nativeProxy){
      if(!manifest.nativeRegion || !manifest.nativeProxy)throw Error('Native detail requires a same-model coarse proxy.');
      const safe=p=>typeof p==='string' && /^[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').includes('..') && !p.startsWith('/');
      if(!safe(manifest.nativeRegion)||!safe(manifest.nativeProxy))throw Error('Invalid native data path.');
      [nativeRegion,nativeProxy]=await Promise.all([NativeRegion.load(new URL(manifest.nativeRegion,base),manifest,{fetchImpl}),NativeProxy.load(new URL(manifest.nativeProxy,base),manifest,{fetchImpl})]);
    }
    return new WorldData(manifest, buffers, {nativeRegion,nativeProxy});
  }

  constructor(manifest, buffers, {nativeRegion=null,nativeProxy=null}={}) {
    validate(manifest);
    this.manifest = manifest;
    this.radius = manifest.radiusM;
    if (!Number.isFinite(this.radius) || this.radius <= 0) throw new Error('Invalid planet radius.');
    this.rows = manifest.grid.rows; this.cols = manifest.grid.cols;
    if (manifest.grid.order !== 'south-first' || manifest.interpolation !== 'cell-centred-bilinear-pole-mean') throw new Error('Unsupported coordinate convention.');
    this.fields = {}; this.poles = {}; this.rawBuffers = buffers; this.byteLength = 0;
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    for (const [key, desc] of Object.entries(manifest.fields)) {
      const b = buffers[key];
      if (!(b instanceof ArrayBuffer) || b.byteLength !== desc.bytes) throw new Error(`Missing field ${key}.`);
      let values;
      if (desc.type === 'f32le') {
        if (little) values = new Float32Array(b);
        else { const view = new DataView(b); values = Float32Array.from({ length: b.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true)); }
        if (!values.every(Number.isFinite)) throw new Error(`Nonfinite native field ${key}.`);
        const mean = row => { let total = 0; for (let c = 0; c < this.cols; c++) total += values[row * this.cols + c]; return total / this.cols; };
        this.poles[key] = [mean(0), mean(this.rows - 1)];
      } else if (desc.type === 'u8') values = new Uint8Array(b);
      else throw new Error(`Unsupported field encoding ${desc.type}.`);
      if (values.length !== this.rows * this.cols) throw new Error(`Invalid native field ${key} length.`);
      this.fields[key] = values; this.byteLength += b.byteLength;
    }
    for (const key of required) if (!this.fields[key]) throw new Error(`Required native field ${key} is absent.`);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < this.fields.surfaceHeight.length; i++) {
      if (this.fields.waterKind[i] > 2) throw new Error('Unknown native water kind.');
      if (this.fields.waterKind[i] && this.fields.surfaceHeight[i] + 0.01 < this.fields.elevation[i]) throw new Error('Native water stage is below the ground.');
      lo = Math.min(lo, this.fields.surfaceHeight[i]); hi = Math.max(hi, this.fields.surfaceHeight[i]);
    }
    this.heightRange = [lo, hi];
    this.sourceSpacing = manifest.sourceResolutionM;
    this.nativeRegion=nativeRegion;this.nativeProxy=nativeProxy;
    this.id = manifest.id;
    if(nativeRegion || nativeProxy){
      if(!nativeRegion || !nativeProxy || nativeRegion.manifest.model!==nativeProxy.manifest.model)throw Error('Native region/proxy model mismatch.');
      if(nativeRegion.parentId!==manifest.id || nativeProxy.parentId!==manifest.id)throw Error('Native detail parent identity mismatch.');
      if(canonical(nativeRegion.manifest.source)!==canonical(nativeProxy.manifest.source))throw Error('Native region/proxy source mismatch.');
      this.id=JSON.stringify([manifest.id,nativeRegion.id,nativeProxy.id,'native-render-proxy/1']);
      this.renderValues=new Float64Array(this.rows*this.cols);
      let rlo=Infinity,rhi=-Infinity;
      for(let y=0;y<this.rows;y++)for(let x=0;x<this.cols;x++){
        const i=y*this.cols+x,lat=((y+.5)/this.rows-.5)*Math.PI,lon=((x+.5)/this.cols-.5)*TAU;
        const h=this.fields.waterKind[i]?this.fields.surfaceHeight[i]:this.fields.elevation[i]+nativeProxy.sampleResidual(lon,lat);
        this.renderValues[i]=h;rlo=Math.min(rlo,h);rhi=Math.max(rhi,h);
      }
      // Explicit native-model pole residuals are part of the proxy contract.
      // Compose the single pole solid height with coarse wet-node stages before
      // averaging display coverage; do not extrapolate an outer control row.
      const poleSurface=(side,row)=>{const solid=this.poles.elevation[side]+nativeProxy.sampleResidual(0,side?Math.PI/2:-Math.PI/2);let sum=0;
        for(let x=0;x<this.cols;x++){const i=row*this.cols+x;sum+=this.fields.waterKind[i]?this.fields.surfaceHeight[i]:solid;}return sum/this.cols;};
      this.renderPoles=[poleSurface(0,0),poleSurface(1,this.rows-1)];
      this.renderGrid={rows:this.rows,cols:this.cols,fields:{surfaceHeight:this.renderValues},poles:{surfaceHeight:this.renderPoles}};
      this.heightRange=[Math.min(rlo,nativeRegion.heightRange[0],...this.renderPoles),Math.max(rhi,nativeRegion.heightRange[1],...this.renderPoles)];
      this.renderGuardM=8*nativeRegion.resolutionM;
      this.nodeToSurface=(height,owner)=>this.fields.waterKind[owner]?this.fields.surfaceHeight[owner]:height;
    }
  }

  sampleField(key, lon, lat) {
    const a = this.fields[key]; if (!a) return null;
    const x = modulo((lon / TAU + 0.5) * this.cols - 0.5, this.cols);
    const y = clamp((lat / Math.PI + 0.5) * this.rows - 0.5, -0.5, this.rows - 0.5);
    const ix = Math.floor(x), fx = x - ix;
    const row = r => a[r * this.cols + ix] * (1 - fx) + a[r * this.cols + (ix + 1) % this.cols] * fx;
    if (!this.poles[key]) return a[clamp(Math.round(y), 0, this.rows - 1) * this.cols + modulo(Math.round(x), this.cols)];
    if (y < 0) { const w = (y + 0.5) * 2; return this.poles[key][0] * (1 - w) + row(0) * w; }
    if (y > this.rows - 1) { const w = (y - this.rows + 1) * 2; return row(this.rows - 1) * (1 - w) + this.poles[key][1] * w; }
    const iy = Math.floor(y), fy = y - iy;
    return row(iy) * (1 - fy) + row(Math.min(iy + 1, this.rows - 1)) * fy;
  }
  nativeWeight(lon,lat){
    if(!this.nativeRegion?.contains(lon,lat))return 0;
    const edges=this.nativeRegion.boundaryDistancesM(lon,lat);let w=1;
    for(const distance of Object.values(edges)){const t=clamp(distance/this.renderGuardM,0,1);w*=t*t*t*(t*(t*6-15)+10);}
    return w;
  }
  renderHeight(lon,lat){
    if(!this.nativeRegion)return this.sampleField('surfaceHeight',lon,lat);
    const coarse=this.sampleField.call(this.renderGrid,'surfaceHeight',lon,lat),w=this.nativeWeight(lon,lat);
    if(w===0)return coarse;
    const fine=this.nativeRegion.sampleRenderSurface(lon,lat,this.nodeToSurface,this.poles.surfaceHeight);
    return coarse*(1-w)+fine*w;
  }
  sampleHeight = d => this.renderHeight(Math.atan2(d[2],d[0]),Math.asin(clamp(d[1],-1,1)));
  resolutionAt(d){const lon=Math.atan2(d[2],d[0]),lat=Math.asin(clamp(d[1],-1,1));return this.nativeWeight(lon,lat)>.999?this.nativeRegion.resolutionM:this.sourceSpacing;}
  sample(lon, lat) {
    const result = {};
    for (const key of Object.keys(this.fields)) result[key] = this.sampleField(key, lon, lat);
    return { ...result, longitude: lon * 180 / Math.PI, latitude: lat * 180 / Math.PI, sourceResolutionM: this.sourceSpacing, nativeHeight:this.nativeRegion?.sample(lon,lat)??null, nativeWeight:this.nativeWeight(lon,lat), renderSurfaceHeight:this.renderHeight(lon,lat), nativeResolutionM:this.nativeRegion?.resolutionM??null };
  }
  workerPayload() {
    return { manifest: this.manifest, buffers: Object.fromEntries(Object.entries(this.rawBuffers).map(([k, b]) => [k, b.slice(0)])), nativeRegion:this.nativeRegion?.workerPayload()??null, nativeProxy:this.nativeProxy?.workerPayload()??null };
  }
  suggestedView() {
    if(this.nativeRegion){
      const rect=this.nativeRegion.manifest.coarseRectangle,[rows,cols]=this.nativeRegion.manifest.nativeGrid;
      let best=null;
      // Data-selected landing: positive dry native surface inside the full-detail guard.
      for(let y=0;y<rect.rowCount*128;y+=4)for(let x=0;x<rect.colCount*128;x+=4){
        const row=rect.rowStart+(y+.5)/128,col=rect.colStart+(x+.5)/128;
        const lat=(row/rows-.5)*Math.PI,lon=(col/cols-.5)*TAU;
        const cell=Math.floor(row)*cols+modulo(Math.floor(col),cols);
        if(this.fields.waterKind[cell] || this.nativeWeight(lon,lat)<.999)continue;
        const h=this.nativeRegion.sample(lon,lat);if(h>0&&(!best||h>best.height))best={latitude:lat,longitude:lon,height:h,cell};
      }
      if(best){const d=this.nativeRegion.resolutionM/this.radius;
        const north=this.renderHeight(best.longitude,best.latitude+d)-this.renderHeight(best.longitude,best.latitude-d);
        const east=this.renderHeight(best.longitude+d,best.latitude)-this.renderHeight(best.longitude-d,best.latitude);
        return {...best,heading:Math.atan2(-east,-north)};}
      throw Error('No positive dry full-detail landing exists in the supplied native region.');
    }
    let best = -Infinity, cell = -1;
    const h = this.fields.elevation;
    for (let row = 1; row < this.rows - 1; row++) for (let col = 0; col < this.cols; col++) {
      const i = row * this.cols + col;
      const lat = ((row + 0.5) / this.rows - 0.5) * Math.PI;
      if (this.fields.waterKind[i] || Math.abs(lat) > Math.PI / 3) continue;
      const relief = Math.abs(h[i + this.cols] - h[i - this.cols]) + Math.abs(h[row * this.cols + (col + 1) % this.cols] - h[row * this.cols + modulo(col - 1, this.cols)]);
      const score = relief + Math.max(0, h[i]) * 0.12;
      if (score > best) { best = score; cell = i; }
    }
    if (cell < 0) cell = Math.floor(this.rows / 2) * this.cols;
    const row=Math.floor(cell/this.cols),col=cell%this.cols;
    const north=h[Math.min(row+1,this.rows-1)*this.cols+col]-h[Math.max(row-1,0)*this.cols+col];
    const east=h[row*this.cols+(col+1)%this.cols]-h[row*this.cols+modulo(col-1,this.cols)];
    return { latitude: ((row + 0.5) / this.rows - 0.5) * Math.PI,
      longitude: ((col + 0.5) / this.cols - 0.5) * TAU, heading:Math.atan2(-east,-north), cell };
  }
}

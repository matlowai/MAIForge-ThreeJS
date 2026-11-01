const TAU=2*Math.PI, HALF_PI=Math.PI/2;
const MODEL='planet-catchment-flow-hillslope/6';
const PREDICTOR='native endpoint datum: cell-centred bilinear with native pole-row means';
const INTERPOLATION='render-only: bilinear residual between the declared latitude/longitude controls, periodic longitude; outer control row blends linearly to declared pole residual';
const MAX_CONTROLS=65536,MAX_MANIFEST_BYTES=128*1024;
const TOKEN=Symbol('validated native proxy');
const b3=/^blake3:[0-9a-f]{64}$/,shaPattern=/^[0-9a-f]{64}$/;
const finite=x=>typeof x==='number'&&Number.isFinite(x),integer=Number.isSafeInteger;
const mod=(x,n)=>((x%n)+n)%n;
const fail=s=>{throw Error('Native proxy: '+s);};
const copyJSON=v=>JSON.parse(JSON.stringify(v));
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function sameArray(a,b){return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x===b[i]);}
function close(a,b){return finite(a)&&finite(b)&&Math.abs(a-b)<=1e-10*Math.max(1,Math.abs(a),Math.abs(b));}
function copyBuffer(b,max,label){if(!(b instanceof ArrayBuffer)||!b.byteLength||b.byteLength>max)fail('invalid '+label+' buffer');return b.slice(0);}
function parse(b){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));}catch{fail('invalid manifest JSON');}}
async function sha(b){if(!globalThis.crypto?.subtle)fail('SHA256 requires HTTPS or localhost');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');}
function parentIdentity(p){
 if(p?.schema!=='maiforge.viewer-world/v1'||typeof p.id!=='string'||!p.id||!integer(p.seed)||p.seed<0||!finite(p.epochMy)||p.epochMy<0||!finite(p.radiusM)||p.radiusM<=0||!integer(p.grid?.rows)||!integer(p.grid?.cols)||p.grid.rows<4||p.grid.cols<4||p.grid.rows*p.grid.cols>4194304||!b3.test(p.sourceArtifacts?.terrain)||!b3.test(p.sourceArtifacts?.hydrology))fail('invalid parent identity');
 return {id:p.id,seed:p.seed,epochMy:p.epochMy,radiusM:p.radiusM,grid:[p.grid.rows,p.grid.cols],terrain:p.sourceArtifacts.terrain,hydrology:p.sourceArtifacts.hydrology};
}
function validate(m,parent){
 if(m?.schema!=='maiforge.viewer-native-proxy/v1'||m.model!==MODEL||!b3.test(m.id))fail('unsupported schema/model/identity');
 if(m.seed!==parent.seed||m.radiusM!==parent.radiusM||!sameArray(m.nativeGrid,parent.grid))fail('parent grid/radius/seed mismatch');
 const s=m.source?.input;
 if(s?.schema!=='maiforge.native-endpoint/v1'||s.seed!==parent.seed||s.epochMy!==parent.epochMy||s.radiusM!==parent.radiusM||!sameArray(s.grid,parent.grid)||s.terrainArtifact!==parent.terrain||s.hydrologyArtifact!==parent.hydrology||!b3.test(s.stratigraphy)||!shaPattern.test(s.subgridSha256)||m.source.hydrology?.artifact!==parent.hydrology||m.source.initial_elevation_law!=='native-centre-observations/monotone-c1/1')fail('native source association mismatch');
 if(m.grid?.order!=='south-first'||m.grid?.layout!=='row-major'||m.grid?.sampling!=='native coarse-cell centres nearest regular control targets; exact coordinates above'||m.predictor!==PREDICTOR||m.interpolation!==INTERPOLATION)fail('unsupported coordinate/predictor convention');
 if(!Array.isArray(m.controlGrid)||m.controlGrid.length!==2)fail('invalid control grid');
 const [ny,nx]=m.controlGrid;
 if(!integer(ny)||!integer(nx)||ny<2||nx<2||ny>parent.grid[0]||nx>parent.grid[1]||ny*nx>MAX_CONTROLS)fail('invalid or oversized control grid');
 const axis=(indices,coordinates,count,nativeCount,span,offset,label)=>{
  if(!Array.isArray(indices)||!Array.isArray(coordinates)||indices.length!==count||coordinates.length!==count)fail('invalid '+label+' controls');
  for(let i=0;i<count;i++){
   if(!integer(indices[i])||indices[i]<0||indices[i]>=nativeCount||(i&&indices[i]<=indices[i-1])||!finite(coordinates[i])||(i&&coordinates[i]<=coordinates[i-1])||Math.abs(coordinates[i]-(offset+(indices[i]+.5)*span/nativeCount))>1e-9)fail('incorrect, duplicate or unsorted '+label+' native centres');
  }
 };
 axis(m.rowIndices,m.latitudeDegrees,ny,parent.grid[0],180,-90,'latitude');
 axis(m.colIndices,m.longitudeDegrees,nx,parent.grid[1],360,-180,'longitude');
 if(!close(m.sourceResolutionM,parent.radiusM*Math.PI/(parent.grid[0]*128)))fail('invalid native process spacing');
 if(!finite(m.maximumCanonicalReplayDifferenceM)||m.maximumCanonicalReplayDifferenceM<0)fail('invalid replay diagnostic');
 if(!Array.isArray(m.poleSamples)||m.poleSamples.length!==2)fail('two explicit pole samples are required');
 const poles=new Map();
 for(const p of m.poleSamples){
  if(!p||![-90,90].includes(p.latitudeDegrees)||poles.has(p.latitudeDegrees)||!finite(p.longitudeDegrees)||p.longitudeDegrees< -180||p.longitudeDegrees>180||![p.nativeM,p.datumM,p.residualM].every(finite)||!close(p.residualM,p.nativeM-p.datumM))fail('invalid, duplicate or inconsistent pole sample');
  poles.set(p.latitudeDegrees,p.residualM);
 }
 const f=m.fields?.residual;
 if(!f||Object.keys(m.fields).length!==1||f.type!=='f32le'||f.unit!=='m'||f.bytes!==ny*nx*4||!shaPattern.test(f.sha256)||!finite(f.maxQuantizationErrorM)||f.maxQuantizationErrorM<0||typeof f.file!=='string'||f.file.length>256||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(f.file))fail('invalid residual descriptor');
 return {ny,nx,field:f,poles:[poles.get(-90),poles.get(90)]};
}
async function read(url,limit,fetchImpl){
 const r=await fetchImpl(url,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'force-cache'});
 if(!r.ok)fail('resource request failed ('+r.status+')');
 const size=r.headers?.get?.('content-length');
 if(size!==null&&size!==undefined&&(!/^\d+$/.test(size)||Number(size)>limit))fail('resource exceeds declared size bound');
 if(r.body?.getReader){const reader=r.body.getReader(),chunks=[];let total=0;for(;;){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();fail('resource exceeds size bound');}chunks.push(value);}const result=new Uint8Array(total);let offset=0;for(const c of chunks){result.set(c,offset);offset+=c.byteLength;}return copyBuffer(result.buffer,limit,'resource');}
 return copyBuffer(await r.arrayBuffer(),limit,'resource');
}
function interval(values,x){let lo=0,hi=values.length;while(lo<hi){const mid=(lo+hi)>>1;if(values[mid]<=x)lo=mid+1;else hi=mid;}return Math.max(0,lo-1);}
const mix=(a,b,t)=>t===0?a:t===1?b:a*(1-t)+b*t;

/** Immutable RAW native-model residual controls. No datum addition, water stage,
 * blending into fine blocks, physics or collision authority is implemented here.
 * Global interpolation error is unknown; native process spacing is not the
 * resolution of this sparse proxy. The caller owns that distinction. */
export class NativeProxy {
 #manifestBytes;#residualBytes;#values;#lat;#lon;#poles;#ny;#nx;
 constructor(token,m,manifestBytes,residualBytes,values,parent,validated){
  if(token!==TOKEN)fail('use load() or fromPayload()');
  this.#manifestBytes=manifestBytes;this.#residualBytes=residualBytes;this.#values=values;
  this.#lat=m.latitudeDegrees.map(v=>v*Math.PI/180);this.#lon=m.longitudeDegrees.map(v=>v*Math.PI/180);
  this.#poles=validated.poles;this.#ny=validated.ny;this.#nx=validated.nx;
  this.id=m.id;this.model=m.model;this.parentId=parent.id;this.manifest=freeze(copyJSON(m));
  let lo=Math.min(...this.#poles),hi=Math.max(...this.#poles);for(const v of values){lo=Math.min(lo,v);hi=Math.max(hi,v);}
  this.heightRangeResidual=Object.freeze([lo,hi]);Object.freeze(this);
 }
 static async load(url,parentManifest,{fetchImpl=globalThis.fetch}={}){
  const parentSnapshot=copyJSON(parentManifest),parent=parentIdentity(parentSnapshot);
  const base=new URL(url,globalThis.location?.href??'http://localhost/');
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password)fail('expected HTTP(S) URL without credentials');
  const proxyManifestBytes=await read(base,MAX_MANIFEST_BYTES,fetchImpl),m=parse(proxyManifestBytes),v=validate(m,parent);
  const residualBytes=await read(new URL(v.field.file,base),v.field.bytes,fetchImpl);
  return NativeProxy.fromPayload({proxyManifestBytes,residualBytes},parentSnapshot);
 }
 static async fromPayload(payload,parentManifest){
  const parent=parentIdentity(copyJSON(parentManifest));
  // Capture all caller-owned bytes before awaiting crypto, so caller mutation or
  // a transfer cannot change what is installed after verification.
  const manifestBytes=copyBuffer(payload?.proxyManifestBytes,MAX_MANIFEST_BYTES,'manifest');
  const residualBytes=copyBuffer(payload?.residualBytes,MAX_CONTROLS*4,'residual');
  const m=parse(manifestBytes),v=validate(m,parent);
  if(residualBytes.byteLength!==v.field.bytes||await sha(residualBytes)!==v.field.sha256)fail('residual hash/length mismatch');
  const view=new DataView(residualBytes),values=new Float32Array(v.ny*v.nx);
  for(let i=0;i<values.length;i++){const x=view.getFloat32(i*4,true);if(!finite(x))fail('nonfinite residual sample');values[i]=x;}
  return new NativeProxy(TOKEN,m,manifestBytes,residualBytes,values,parent,v);
 }
 workerPayload(){return {proxyManifestBytes:this.#manifestBytes.slice(0),residualBytes:this.#residualBytes.slice(0)};}
 sampleResidual(lon,lat){
  if(!finite(lon)||!finite(lat)||lat< -HALF_PI||lat>HALF_PI)return null;
  if(lat===-HALF_PI)return this.#poles[0];if(lat===HALF_PI)return this.#poles[1];
  const x=mod(lon-this.#lon[0],TAU)+this.#lon[0],ix=interval(this.#lon,x),next=(ix+1)%this.#nx;
  const x1=ix===this.#nx-1?this.#lon[0]+TAU:this.#lon[ix+1],fx=(x-this.#lon[ix])/(x1-this.#lon[ix]);
  const row=y=>mix(this.#values[y*this.#nx+ix],this.#values[y*this.#nx+next],fx);
  if(lat<=this.#lat[0])return mix(this.#poles[0],row(0),(lat+HALF_PI)/(this.#lat[0]+HALF_PI));
  if(lat>=this.#lat[this.#ny-1])return mix(row(this.#ny-1),this.#poles[1],(lat-this.#lat[this.#ny-1])/(HALF_PI-this.#lat[this.#ny-1]));
  const iy=interval(this.#lat,lat),fy=(lat-this.#lat[iy])/(this.#lat[iy+1]-this.#lat[iy]);
  return mix(row(iy),row(iy+1),fy);
 }
}

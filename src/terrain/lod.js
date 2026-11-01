import { EDGES, directionFace, faceDirection, projectDirection, neighbourSample, tileBounds, tileChildren, tileKey, validateTile } from './cube.js';
import { renderedHeightAtDirection } from './mesh.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const angleBetween = (a,b) => Math.atan2(Math.hypot(...cross(a,b)),clamp(dot(a,b),-1,1));

function arcDistance(dir,a,b) {
  let closest=Math.min(angleBetween(dir,a),angleBetween(dir,b));
  const n=cross(a,b),len=Math.hypot(...n);
  if(len<1e-15)return closest;
  for(let k=0;k<3;k++)n[k]/=len;
  const projection=dir.map((v,k)=>v-n[k]*dot(dir,n)),qlen=Math.hypot(...projection);
  if(qlen<1e-15)return closest;
  const q=projection.map(v=>v/qlen);
  if(dot(cross(a,q),n)>=-1e-14&&dot(cross(q,b),n)>=-1e-14)closest=Math.min(closest,angleBetween(dir,q));
  return closest;
}
function footprintDistance(dir,tile,b,corners) {
  const p=projectDirection(tile.face,dir);
  if(p&&p.u>=b.u0&&p.u<=b.u1&&p.v>=b.v0&&p.v<=b.v1)return 0;
  let gap=Math.PI;
  for(let i=0;i<4;i++)gap=Math.min(gap,arcDistance(dir,corners[i],corners[(i+1)%4]));
  return gap;
}

const roots = () => Array.from({ length: 6 }, (_, face) => ({ face, level: 0, x: 0, y: 0 }));
const sortTiles = tiles => tiles.sort((a, b) => a.face - b.face || a.level - b.level || a.y - b.y || a.x - b.x);

function indexCut(tiles, checkComplete = false) {
  const byKey = new Map(); let maxLevel = 0;
  for (const t of tiles) {
    validateTile(t);
    const key = tileKey(t);
    if (byKey.has(key)) throw new Error(`Duplicate rendered tile ${key}`);
    byKey.set(key, t); maxLevel = Math.max(maxLevel, t.level);
  }
  if (checkComplete) {
    const branches = new Set();
    for (const t of tiles) {
      for (let l = t.level - 1; l >= 0; --l) {
        const div = 2 ** (t.level - l);
        const key = tileKey({ face: t.face, level: l, x: Math.floor(t.x / div), y: Math.floor(t.y / div) });
        if (byKey.has(key)) throw new Error('Overlapping parent and child in rendered cut');
        branches.add(key);
      }
    }
    const visit = t => {
      const key = tileKey(t);
      if (byKey.has(key)) return;
      if (!branches.has(key)) throw new Error(`Incomplete rendered cut at ${key}`);
      for (const c of tileChildren(t)) visit(c);
    };
    for (const r of roots()) visit(r);
  }
  return { byKey, maxLevel };
}
// Cache repeated masks/point queries for one rendered array, while detecting
// replacements, reordering AND in-place address mutations. Never cache a mutable
// working selection index, which balancing/splitting changes internally.
const cutCache = new WeakMap();
function queryIndex(tiles) {
  const cached = cutCache.get(tiles);
  let same = cached?.addresses.length === tiles.length;
  if (same) for (let i=0;i<tiles.length;i++) {
    const t=tiles[i], a=cached.addresses[i];
    if (t.face!==a[0] || t.level!==a[1] || t.x!==a[2] || t.y!==a[3]) { same=false; break; }
  }
  if (same) return cached.index;
  const index=indexCut(tiles);
  cutCache.set(tiles,{index,addresses:tiles.map(t=>[t.face,t.level,t.x,t.y])});
  return index;
}

function lookup(index, point) {
  const u = clamp((point.u + 1) * 0.5, 0, 1 - Number.EPSILON);
  const v = clamp((point.v + 1) * 0.5, 0, 1 - Number.EPSILON);
  for (let level = 0; level <= index.maxLevel; level++) {
    const n = 2 ** level;
    const t = index.byKey.get(`${point.face}/${level}/${Math.floor(u * n)}/${Math.floor(v * n)}`);
    if (t) return t;
  }
  return null;
}
function split(map, tile) {
  map.delete(tileKey(tile));
  for (const c of tileChildren(tile)) map.set(tileKey(c), c);
}

/** Complete covering input required. Only coarsens existing subtrees. */
export function balanceByCoarsening(tiles) {
  let index = indexCut(tiles, true);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (const t of index.byKey.values()) {
      for (const edge of EDGES) {
        const other = lookup(index, neighbourSample(t, edge));
        if (!other) throw new Error('Rendered cut has missing neighbor');
        if (t.level <= other.level + 1) continue;
        const level = other.level + 1, div = 2 ** (t.level - level);
        const ancestor = { face: t.face, level, x: Math.floor(t.x / div), y: Math.floor(t.y / div) };
        for (const [key, leaf] of index.byKey) {
          if (leaf.face !== ancestor.face || leaf.level < level) continue;
          const scale = 2 ** (leaf.level - level);
          if (Math.floor(leaf.x / scale) === ancestor.x && Math.floor(leaf.y / scale) === ancestor.y) index.byKey.delete(key);
        }
        index.byKey.set(tileKey(ancestor), ancestor);
        index = indexCut([...index.byKey.values()]);
        changed = true; break outer;
      }
    }
  }
  return sortTiles([...index.byKey.values()]);
}

function maskInIndex(tile,index) {
  let mask=0;
  if (!index.byKey.has(tileKey(tile))) throw new Error('Stitch mask requires a tile in the actual rendered cut');
  for (const edge of EDGES) {
    const other = lookup(index, neighbourSample(tile, edge));
    if (!other) throw new Error('Cannot stitch an incomplete rendered cut');
    if (Math.abs(tile.level - other.level) > 1) throw new Error('Balance the actual rendered cut before stitching');
    if (other.level < tile.level) mask |= edge;
  }
  return mask;
}
export function edgeMask(tile, renderedTiles) { return maskInIndex(tile,queryIndex(renderedTiles)); }

export function getTileAtDirection(tiles, dir) {
  return lookup(queryIndex(tiles), directionFace(dir));
}

/**
 * Budgeted, complete, balanced render selection. SSE is an estimate based on
 * sphere curvature and declared source spacing/range, not a source-data accuracy
 * guarantee. cameraAltitude optionally supplies clearance above sampled ground. When sampleHeight
 * is provided, reserve a measured stitched-triangle navigation constraint first.
 * This matches the supplied source representation; it does not add source geology.
 */
export function selectTiles(options) {
  const { cameraPosition, viewDirection, radius, viewportHeight, fovY } = options;
  if (!cameraPosition?.every(Number.isFinite) || cameraPosition.length !== 3 || !(radius > 0) ||
      !(viewportHeight > 0) || !(fovY > 0 && fovY < Math.PI)) throw new RangeError('Invalid view for terrain selection');
  const maxTiles = Math.floor(options.maxTiles ?? 192), maxLevel = Math.floor(options.maxLevel ?? 20);
  const gridSize = options.gridSize ?? 32, pixelError = options.pixelError ?? 2;
  if (maxTiles < 6 || maxLevel < 0 || maxLevel > 30 || !Number.isFinite(maxTiles) ||
      !Number.isInteger(gridSize) || gridSize < 2 || gridSize > 512 || gridSize % 2 || !(pixelError > 0)) throw new RangeError('Invalid LOD budget');
  const cameraRadius = Math.hypot(...cameraPosition);
  if (!(cameraRadius > 0)) throw new RangeError('Camera is at planet centre');
  const cameraUnit = cameraPosition.map(x => x / cameraRadius);
  if (viewDirection !== undefined && (viewDirection.length !== 3 || !viewDirection.every(Number.isFinite))) throw new RangeError('Invalid view direction');
  const viewLength = viewDirection?.length === 3 ? Math.hypot(...viewDirection) : 0;
  const view = viewLength > 0 ? viewDirection.map(x => x / viewLength) : cameraUnit.map(x => -x);
  const hr = options.heightRange ?? 0;
  const minHeight = Array.isArray(hr) ? hr[0] : -Math.abs(hr);
  const maxHeight = Array.isArray(hr) ? hr[1] : Math.abs(hr);
  if (![minHeight, maxHeight].every(Number.isFinite) || minHeight > maxHeight || radius + minHeight <= 0) throw new RangeError('Invalid height range');
  const amplitude = maxHeight - minHeight;
  const spacing = options.sourceSpacing ?? radius;
  if (!(spacing > 0) || !Number.isFinite(spacing)) throw new RangeError('Invalid source spacing');
  const altitude = options.cameraAltitude === undefined ? Math.max(0.1, cameraRadius - radius - maxHeight) : Math.max(0.1, options.cameraAltitude);
  if (!Number.isFinite(altitude)) throw new RangeError('Invalid camera altitude');
  const sampleHeight=options.sampleHeight;
  if(sampleHeight!==undefined&&typeof sampleHeight!=='function')throw new RangeError('Invalid navigation height sampler');
  const navigationTarget=options.navigationErrorM??Math.max(0.05,altitude*0.02);
  if(!Number.isFinite(navigationTarget)||navigationTarget<=0)throw new RangeError('Invalid navigation error target');
  const projection = viewportHeight / (2 * Math.tan(fovY / 2));
  const occluder = radius + minHeight, highest = radius + maxHeight;
  const horizon = cameraRadius > occluder ? Math.acos(clamp(occluder / cameraRadius, -1, 1)) + Math.acos(clamp(occluder / highest, -1, 1)) : Math.PI;
  const ancestors = new Set();
  for (const key of options.previousKeys ?? []) {
    const values = typeof key === 'string' ? key.split('/').map(Number) : [key.face, key.level, key.x, key.y];
    const [face, level, x, y] = values;
    if (!values.every(Number.isInteger) || level < 0 || level > 30) continue;
    for (let l = 0; l < level; l++) {
      const scale = 2 ** (level - l);
      ancestors.add(`${face}/${l}/${Math.floor(x / scale)}/${Math.floor(y / scale)}`);
    }
  }
  const scores = new Map();
  const score = tile => {
    const key = tileKey(tile); if (scores.has(key)) return scores.get(key);
    const b = tileBounds(tile), center = faceDirection(tile.face, (b.u0 + b.u1) / 2, (b.v0 + b.v1) / 2);
    const corners=[[b.u0,b.v0],[b.u1,b.v0],[b.u1,b.v1],[b.u0,b.v1]].map(([u,v])=>faceDirection(tile.face,u,v));
    const angularRadius=Math.max(...corners.map(d=>angleBetween(center,d)));
    const angle=angleBetween(center,cameraUnit);
    const visible = angle - angularRadius <= horizon + 1e-10;
    if(!visible){const result={sse:0,visible:false,priority:0};scores.set(key,result);return result;}
    // A circular angular bound is useful for conservative visibility, but many
    // overlapping bounds wrongly report zero camera distance. Use the actual
    // spherical quadrilateral footprint for distance/priority.
    const gap=footprintDistance(cameraUnit,tile,b,corners),distance=Math.hypot(altitude,radius*gap);
    const cellSpan = 2 * radius / (2 ** tile.level * gridSize);
    const error = cellSpan * cellSpan / (8 * radius) + amplitude * Math.min(1, (cellSpan / spacing) ** 2);
    const sse = error * projection / Math.max(0.1, distance);
    const delta = center.map((x,i) => x * (radius + (minHeight + maxHeight) / 2) - cameraPosition[i]);
    const length = Math.hypot(...delta);
    const facing = length > 0 ? clamp(dot(delta,view) / length,-1,1) : 1;
    const threshold = pixelError * (ancestors.has(key) ? 0.6 : 1);
    const priority = visible && sse > threshold && tile.level < maxLevel ? sse / threshold * (0.15 + 0.85 * Math.max(0,facing)) : 0;
    const result = { sse, visible, priority }; scores.set(key,result); return result;
  };
  let index = indexCut(roots()); const blocked = new Set(); let splitCount = 0, balancingSplits = 0;
  let navigationSplits=0,navigationSamples=0;
  const cameraPoint=directionFace(cameraUnit),navCache=new Map();
  const sourceSample=d=>{
    navigationSamples++;
    const h=sampleHeight(d);
    if(!Number.isFinite(h)||!Number.isFinite(radius+h)||radius+h<=0)throw new RangeError('Invalid navigation source height');
    return h;
  };
  const nativeGround=sampleHeight?sourceSample(cameraUnit):null;
  const navigationProbe=idx=>{
    if(!sampleHeight)return null;
    const tile=lookup(idx,cameraPoint),mask=maskInIndex(tile,idx),key=tileKey(tile)+'/'+mask;
    if(navCache.has(key))return navCache.get(key);
    const b=tileBounds(tile),q=projectDirection(tile.face,cameraUnit),n=gridSize;
    const gx=clamp((q.u-b.u0)/(b.u1-b.u0)*n,0,n),gy=clamp((q.v-b.v0)/(b.v1-b.v0)*n,0,n);
    const ix=Math.min(n-1,Math.floor(gx)),iy=Math.min(n-1,Math.floor(gy));
    const point=d=>{const h=sourceSample(d);return d.map(v=>v*(radius+h));};
    const anchor=point(faceDirection(tile.face,(b.u0+b.u1)/2,(b.v0+b.v1)/2));
    // The shared triangle-query function examines adjacent cells and 2:1 edge
    // collapses. Populate its complete possible vertex neighborhood, with the
    // exact same Float32-local conversion as buildTile, without normal sampling.
    const positions=new Float32Array((n+1)*(n+1)*3);positions.fill(NaN);
    for(let y=Math.max(0,iy-2);y<=Math.min(n,iy+3);y++)for(let x=Math.max(0,ix-2);x<=Math.min(n,ix+3);x++){
      const d=faceDirection(tile.face,b.u0+(b.u1-b.u0)*x/n,b.v0+(b.v1-b.v0)*y/n),p=point(d),at=3*(y*(n+1)+x);
      for(let k=0;k<3;k++)positions[at+k]=p[k]-anchor[k];
    }
    const rendered=renderedHeightAtDirection({tile,gridSize:n,positions,anchor,radius},cameraUnit,mask);
    if(rendered===null)throw new Error('Navigation triangle could not be located');
    const result={tile,mask,native:nativeGround,rendered,error:Math.abs(rendered-nativeGround)};
    navCache.set(key,result);return result;
  };
  const requiredSplits=(chosen,idx)=>{
    const required=new Map([[tileKey(chosen),chosen]]),queue=[chosen];
    for(let cursor=0;cursor<queue.length;cursor++){
      const t=queue[cursor];
      for(const edge of EDGES){
        const other=lookup(idx,neighbourSample(t,edge));
        if(!other)throw new Error('Selection lost complete coverage');
        if(other.level<t.level&&!required.has(tileKey(other))){required.set(tileKey(other),other);queue.push(other);}
      }
    }
    return required;
  };
  const applySplits=(idx,required)=>{
    for(const t of required.values())split(idx.byKey,t);
    idx.maxLevel=Math.max(idx.maxLevel,...[...required.values()].map(t=>t.level+1));
  };
  // Navigation is not optional merely because the point is below or behind the
  // view direction. Reserve its actual source/triangle tolerance before visual
  // priority consumes the budget. No heights or source values are changed.
  let navigation=navigationProbe(index),navigationBudgetLimited=false,navigationLevelLimited=false;
  while(navigation&&navigation.error>navigationTarget){
    if(navigation.tile.level>=maxLevel){navigationLevelLimited=true;break;}
    const required=requiredSplits(navigation.tile,index);
    if(index.byKey.size+required.size*3>maxTiles){navigationBudgetLimited=true;break;}
    applySplits(index,required);splitCount+=required.size;balancingSplits+=required.size-1;navigationSplits+=required.size;
    navigation=navigationProbe(index);
  }
  while (index.byKey.size + 3 <= maxTiles) {
    let chosen = null, best = 0;
    for (const t of index.byKey.values()) {
      if (blocked.has(tileKey(t))) continue;
      const p = score(t).priority;
      if (p > best) { best = p; chosen = t; }
    }
    if (!chosen) break;
    const required=requiredSplits(chosen,index);
    if(index.byKey.size+required.size*3>maxTiles){blocked.add(tileKey(chosen));continue;}
    // Refining a coarser neighbor can change the underfoot stitch mask. Do not
    // trade away an already achieved navigation constraint for visual priority.
    let affectsNavigation=navigation&&required.has(tileKey(navigation.tile));
    if(navigation&&!affectsNavigation)for(const edge of EDGES){
      const other=lookup(index,neighbourSample(navigation.tile,edge));
      if(other.level<navigation.tile.level&&required.has(tileKey(other)))affectsNavigation=true;
    }
    if(affectsNavigation){
      const trial={byKey:new Map(index.byKey),maxLevel:index.maxLevel};applySplits(trial,required);
      const next=navigationProbe(trial);
      if(navigation.error<=navigationTarget&&next.error>navigationTarget){blocked.add(tileKey(chosen));continue;}
      index=trial;navigation=next;
    }else applySplits(index,required);
    splitCount+=required.size;balancingSplits+=required.size-1;
  }
  navigation=navigationProbe(index);

  const tiles = sortTiles([...index.byKey.values()]);
  const visibleScores = tiles.map(t=>score(t)).filter(s=>s.visible);
  const maxSSE = Math.max(0,...visibleScores.map(s=>s.sse));
  return { tiles, metrics: { tileCount:tiles.length, visibleCount:visibleScores.length,
    maxLevel:Math.max(...tiles.map(t=>t.level)), estimatedMaxSSE:maxSSE,
    budgetLimited:tiles.some(t=>score(t).priority>0)||(navigation?.error>navigationTarget&&navigationBudgetLimited), splitCount, balancingSplits,
    pixelError, errorIsEstimate:true,
    navigationErrorM:navigation?.error??null,navigationTargetM:sampleHeight?navigationTarget:null,
    navigationSatisfied:navigation?navigation.error<=navigationTarget:null,
    navigationLevel:navigation?.tile.level??null,
    navigationBudgetLimited:!!(navigation&&navigation.error>navigationTarget&&navigationBudgetLimited),
    navigationLevelLimited:!!(navigation&&navigation.error>navigationTarget&&navigationLevelLimited),
    navigationSamples,navigationSplits } };
}

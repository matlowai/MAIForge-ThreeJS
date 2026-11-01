import { W, E, S, N, faceDirection, projectDirection, tileBounds } from './cube.js';

const indexCache = new Map();
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a,b) => a.map((x,i)=>x-b[i]);
const normalize = a => { const n=Math.hypot(...a); return a.map(x=>x/n); };
function checkGrid(n) { if (!Number.isInteger(n) || n < 2 || n > 512 || n%2) throw new RangeError('Grid size must be even, between2 and512'); }

function mappedIndex(x,y,n,mask) {
  // Opposite edges collapse toward opposite endpoints. Collapsing every edge
  // downward leaves a collinear interior T-junction at a doubly stitched corner.
  if (y===0 && (mask&S) && x%2) x--;
  if (y===n && (mask&N) && x%2) x++;
  if (x===0 && (mask&W) && y%2) y--;
  if (x===n && (mask&E) && y%2) y++;
  return y*(n+1)+x;
}
function cellTriangles(x,y,n,mask) {
  const a=mappedIndex(x,y,n,mask), b=mappedIndex(x+1,y,n,mask),
    c=mappedIndex(x,y+1,n,mask), d=mappedIndex(x+1,y+1,n,mask);
  return [[a,b,c],[b,d,c]];
}
/** Cached index arrays are shared; callers must treat them as immutable. */
export function indicesForMask(gridSize,mask=0) {
  checkGrid(gridSize);
  if (!Number.isInteger(mask)||mask<0||mask>15) throw new RangeError('Invalid stitch mask');
  const key=`${gridSize}/${mask}`; if(indexCache.has(key))return indexCache.get(key);
  const indices=[];
  for(let y=0;y<gridSize;y++)for(let x=0;x<gridSize;x++) {
    for(const tri of cellTriangles(x,y,gridSize,mask)) if(new Set(tri).size===3)indices.push(...tri);
  }
  const Type=(gridSize+1)**2<=65536?Uint16Array:Uint32Array;
  const result=new Type(indices); indexCache.set(key,result); return result;
}

export function buildTile(tile,{radius,gridSize=32,sampleHeight,normalStep=25}) {
  checkGrid(gridSize);
  if(!(radius>0)||!Number.isFinite(radius)||!(normalStep>0)||!Number.isFinite(normalStep)||typeof sampleHeight!=='function')throw new RangeError('Invalid mesh source');
  const bounds=tileBounds(tile), stride=gridSize+1, count=stride*stride;
  const point=d=>{
    const h=sampleHeight(d);
    if(!Number.isFinite(h)||!Number.isFinite(radius+h)||radius+h<=0)throw new RangeError('Height source returned an invalid radius');
    return d.map(v=>v*(radius+h));
  };
  const anchor=point(faceDirection(tile.face,(bounds.u0+bounds.u1)/2,(bounds.v0+bounds.v1)/2));
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),planetPositions=new Float32Array(count*3);
  const step=normalStep/radius;
  if (!Number.isFinite(step)) throw new RangeError('Normal sampling scale exceeds numeric range');
  for(let y=0;y<=gridSize;y++)for(let x=0;x<=gridSize;x++) {
    const u=bounds.u0+(bounds.u1-bounds.u0)*x/gridSize, v=bounds.v0+(bounds.v1-bounds.v0)*y/gridSize;
    const d=faceDirection(tile.face,u,v), p=point(d);
    const tangent=normalize(cross(Math.abs(d[1])<0.9?[0,1,0]:[1,0,0],d));
    const bitangent=cross(d,tangent);
    const derivative=t=>sub(point(normalize(d.map((a,i)=>a+t[i]*step))),point(normalize(d.map((a,i)=>a-t[i]*step))));
    let normal=normalize(cross(derivative(tangent),derivative(bitangent)));
    if(!normal.every(Number.isFinite)) throw new RangeError('Height source has a degenerate sampled normal');
    if(dot(normal,d)<0)normal=normal.map(a=>-a);
    const i=3*(y*stride+x);
    for(let k=0;k<3;k++){positions[i+k]=p[k]-anchor[k];normals[i+k]=normal[k];planetPositions[i+k]=p[k]/radius;}
  }
  return {anchor,positions,normals,planetPositions,gridSize,tile:{...tile},radius};
}

/** Radial height of the ACTUAL stitched triangles, for render-camera clearance. */
export function renderedHeightAtDirection(meshData,dir,mask=0) {
  const {tile,gridSize:n,positions,anchor,radius}=meshData;
  if (!(radius>0) || !Number.isFinite(radius)) throw new RangeError('Mesh radius metadata is required');
  if(!dir?.every(Number.isFinite)||dir.length!==3||Math.hypot(...dir)===0)return null;
  if(!Number.isInteger(mask)||mask<0||mask>15)throw new RangeError('Invalid stitch mask');
  const d=normalize(dir), p=projectDirection(tile.face,d); if(!p)return null;
  const b=tileBounds(tile), eps=(b.u1-b.u0)*1e-7+Number.EPSILON*32;
  if(p.u<b.u0-eps||p.u>b.u1+eps||p.v<b.v0-eps||p.v>b.v1+eps)return null;
  const gx=Math.max(0,Math.min(n,(p.u-b.u0)/(b.u1-b.u0)*n));
  const gy=Math.max(0,Math.min(n,(p.v-b.v0)/(b.v1-b.v0)*n));
  const ix=Math.min(n-1,Math.floor(gx)),iy=Math.min(n-1,Math.floor(gy));
  const vertex=i=>[positions[3*i],positions[3*i+1],positions[3*i+2]];
  // Work near the surface instead of subtracting two Earth-sized ray distances.
  // q0 is the radial datum point in the patch-local frame, in double precision.
  const q0=d.map((x,i)=>x*radius-anchor[i]);
  let best=null;
  for(let y=Math.max(0,iy-1);y<=Math.min(n-1,iy+1);y++)for(let x=Math.max(0,ix-1);x<=Math.min(n-1,ix+1);x++) {
    for(const ids of cellTriangles(x,y,n,mask)) {
      if(new Set(ids).size<3)continue;
      const [a,bb,c]=ids.map(vertex),e1=sub(bb,a),e2=sub(c,a),normal=cross(e1,e2);
      const denominator=dot(normal,d);if(Math.abs(denominator)<1e-20)continue;
      const h=dot(normal,sub(a,q0))/denominator;
      if(!Number.isFinite(h)||!Number.isFinite(radius+h)||radius+h<=0)continue;
      const q=q0.map((v,i)=>v+h*d[i]),ap=sub(q,a);
      const d00=dot(e1,e1),d01=dot(e1,e2),d11=dot(e2,e2),d20=dot(ap,e1),d21=dot(ap,e2);
      const den=d00*d11-d01*d01;if(!(den>0))continue;
      const v=(d11*d20-d01*d21)/den,w=(d00*d21-d01*d20)/den;
      if(v>=-1e-6&&w>=-1e-6&&v+w<=1+1e-6)best=best===null?h:Math.max(best,h);
    }
  }
  return best;
}

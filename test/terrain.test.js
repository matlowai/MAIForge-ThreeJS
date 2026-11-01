import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WorldData } from '../src/engine/WorldData.js';
import { W,E,S,N,EDGES,faceDirection,directionFace,projectDirection,tileBounds,tileChildren,tileKey,neighbourSample } from '../src/terrain/cube.js';
import { selectTiles,balanceByCoarsening,edgeMask,getTileAtDirection } from '../src/terrain/lod.js';
import { buildTile,indicesForMask,renderedHeightAtDirection } from '../src/terrain/mesh.js';
const R=6371000;
const roots=()=>Array.from({length:6},(_,face)=>({face,level:0,x:0,y:0}));
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const difference=(a,b)=>a.map((x,i)=>x-b[i]);
const height=d=>1200*d[0]*d[2]+320*d[1]+70*d[0]*d[1];
const vertex=(m,x,y)=>{const i=3*(y*(m.gridSize+1)+x);return m.anchor.map((a,k)=>a+m.positions[i+k]);};
function replace(cut,t){return cut.filter(a=>tileKey(a)!==tileKey(t)).concat(tileChildren(t));}
function assertCompleteBalanced(tiles,budget=Infinity){
 assert.ok(tiles.length<=budget);
 for(let f=0;f<6;f++){
  const list=tiles.filter(t=>t.face===f);
  assert.ok(Math.abs(list.reduce((a,t)=>a+4/4**t.level,0)-4)<1e-12,'face area must be covered exactly');
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
   const a=tileBounds(list[i]),b=tileBounds(list[j]);
   assert.ok(!(Math.min(a.u1,b.u1)>Math.max(a.u0,b.u0)&&Math.min(a.v1,b.v1)>Math.max(a.v0,b.v0)),'leaf interiors overlap');
  }
 }
 for(const t of tiles)for(const edge of EDGES){
  const p=neighbourSample(t,edge),n=getTileAtDirection(tiles,faceDirection(p.face,p.u,p.v));
  assert.ok(n,'every edge has a neighbor');assert.ok(Math.abs(t.level-n.level)<=1,'unbalanced rendered edge');
 }
}

test('cube addressing round-trips and all twelve root-face edges are connected',()=>{
 const pairs=new Set();
 for(let face=0;face<6;face++){
  for(const [u,v] of [[0,0],[.37,-.81],[-1,-1],[-1,1],[1,-1],[1,1]]){
   const d=faceDirection(face,u,v),p=directionFace(d),q=faceDirection(p.face,p.u,p.v);
   assert.ok(Math.abs(Math.hypot(...d)-1)<1e-15);assert.ok(distance(d,q)<1e-15);
   const own=projectDirection(face,d);assert.ok(Math.abs(own.u-u)<1e-15&&Math.abs(own.v-v)<1e-15);
  }
  for(const edge of EDGES){const p=neighbourSample({face,level:0,x:0,y:0},edge);assert.notEqual(p.face,face);pairs.add([face,p.face].sort().join(':'));}
 }
 assert.equal(pairs.size,12);
 assert.throws(()=>directionFace([0,0,0]));
});

test('all stitch masks preserve area, winding and manifold interior topology',()=>{
 const n=8,stride=n+1;
 for(let mask=0;mask<16;mask++){
  const idx=indicesForMask(n,mask),edges=new Map(),triangles=new Set();let area=0;
  const xy=i=>[i%stride,Math.floor(i/stride)];
  for(let i=0;i<idx.length;i+=3){
   const ids=[idx[i],idx[i+1],idx[i+2]], [a,b,c]=ids.map(xy);
   const twice=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
   assert.ok(twice>0,`mask${mask} degenerate/inverted triangle`);area+=twice/2;
   const tk=ids.slice().sort((a,b)=>a-b).join(':');assert.ok(!triangles.has(tk));triangles.add(tk);
   for(const v of ids){assert.ok(v<stride*stride);const [x,y]=xy(v);if((mask&W)&&x===0)assert.equal(y%2,0);if((mask&E)&&x===n)assert.equal(y%2,0);if((mask&S)&&y===0)assert.equal(x%2,0);if((mask&N)&&y===n)assert.equal(x%2,0);}
   for(let e=0;e<3;e++){const k=[ids[e],ids[(e+1)%3]].sort((a,b)=>a-b).join(':');edges.set(k,(edges.get(k)||0)+1);}
  }
  assert.equal(area,n*n);
  for(const [key,count] of edges){
   assert.ok(count===1||count===2);if(count===2)continue;
   const [a,b]=key.split(':').map(Number).map(xy);
   assert.ok((a[0]===0&&b[0]===0)||(a[0]===n&&b[0]===n)||(a[1]===0&&b[1]===0)||(a[1]===n&&b[1]===n),'unpaired interior edge/hole');
  }
 }
 assert.throws(()=>indicesForMask(7,0));
});

test('coarsening repairs a deeply unbalanced cut without creating coverage holes',()=>{
 let cut=roots(),t=cut[0];
 for(let i=0;i<6;i++){cut=replace(cut,t);t=tileChildren(t)[0];}
 const repaired=balanceByCoarsening(cut);
 assert.ok(repaired.length<cut.length);assertCompleteBalanced(repaired);
 assert.throws(()=>balanceByCoarsening(roots().slice(1)),/Incomplete/);
 assert.throws(()=>balanceByCoarsening(roots().concat(tileChildren(roots()[0]))),/Overlapping/);
});

const view=(alt,maxTiles=192)=>({cameraPosition:[R+350+alt,0,0],cameraAltitude:alt,viewDirection:[0,0,1],radius:R,viewportHeight:900,fovY:Math.PI/3,pixelError:2,maxTiles,maxLevel:20,gridSize:32,sourceSpacing:69500,heightRange:[-6000,8000]});
test('selection honors its hard budget and complete balanced cover from orbit to ground',()=>{
 const orbit=selectTiles(view(1e6,96)),near=selectTiles(view(2,96));
 assertCompleteBalanced(orbit.tiles,96);assertCompleteBalanced(near.tiles,96);
 assert.ok(getTileAtDirection(near.tiles,[1,0,0]).level>getTileAtDirection(orbit.tiles,[1,0,0]).level);
 assert.deepEqual(near.tiles,selectTiles(view(2,96)).tiles);
 assert.equal(selectTiles(view(2,6)).tiles.length,6);
 assert.equal(selectTiles(view(2,6)).metrics.budgetLimited,true);
 assert.throws(()=>selectTiles(view(2,5)),/budget/);
});

test('selected actual cuts stitch only to existing coarser neighbors',()=>{
 let cut=roots();cut=replace(cut,cut[0]);assertCompleteBalanced(cut);
 const t={face:0,level:1,x:0,y:0};assert.equal(edgeMask(t,cut),W|S);
 let bad=cut;for(let k=0;k<3;k++){const fine=bad.filter(t=>t.face===0&&t.x===0&&t.y===0).sort((a,b)=>b.level-a.level)[0];bad=replace(bad,fine);}
 assert.throws(()=>edgeMask(bad.find(t=>t.face===0&&t.level===4&&t.x===0&&t.y===0),bad),/Balance/);
});

test('near-ground cross-face LOD edges share samples, normals and stitched endpoints',()=>{
 const fine={face:0,level:15,x:0,y:16400},coarse={face:4,level:14,x:16383,y:8200},n=8;
 const a=buildTile(fine,{radius:R,gridSize:n,sampleHeight:height});
 const b=buildTile(coarse,{radius:R,gridSize:n,sampleHeight:height});
 const af=tileBounds(fine),bc=tileBounds(coarse);
 for(let k=0;k<=n/2;k++){
  const da=faceDirection(0,-1,af.v0+(af.v1-af.v0)*(2*k)/n);
  const db=faceDirection(4,1,bc.v0+(bc.v1-bc.v0)*k/n);
  assert.deepEqual(da,db,'source samples must be globally identical');
  assert.ok(distance(vertex(a,0,2*k),vertex(b,n,k))<0.001,'near rendered endpoints differ by >1mm');
  const ai=3*((2*k)*(n+1)),bi=3*(k*(n+1)+n);
  assert.deepEqual([...a.normals.slice(ai,ai+3)],[...b.normals.slice(bi,bi+3)]);
  const ha=renderedHeightAtDirection(a,da,W),hb=renderedHeightAtDirection(b,da,0);
  assert.notEqual(ha,null);assert.notEqual(hb,null);assert.ok(Math.abs(ha-hb)<0.001);
 }
 // Falsifier: without W stitching the odd edge sample does not lie on the
 // coarse edge chord. This is measurable even for a mathematically flat sphere.
 const aa=buildTile({face:0,level:1,x:0,y:0},{radius:R,gridSize:n,sampleHeight:()=>0});
 const bb=buildTile({face:4,level:0,x:0,y:0},{radius:R,gridSize:n,sampleHeight:()=>0});
 const d=faceDirection(0,-1,-.875);
 const unst=renderedHeightAtDirection(aa,d,0),stitched=renderedHeightAtDirection(aa,d,W),parent=renderedHeightAtDirection(bb,d,0);
 assert.ok(Math.abs(unst-parent)>100,'falsifier must expose a real unstiched gap');
 assert.ok(Math.abs(stitched-parent)<1,'stitched root-scale float error must remain bounded');
});

test('renderedHeight returns the real triangle chord rather than ideal source height',()=>{
 const m=buildTile({face:0,level:0,x:0,y:0},{radius:R,gridSize:8,sampleHeight:()=>0});
 const d=faceDirection(0,.125,.125),h=renderedHeightAtDirection(m,d,0);
 assert.notEqual(h,null);assert.ok(h < -1000,'coarse sphere chord lies well below analytic sphere');
 const a=vertex(m,4,4),b=vertex(m,5,4),c=vertex(m,4,5),nn=cross(difference(b,a),difference(c,a));
 const expected=dot(nn,a)/dot(nn,d)-R;
 assert.ok(Math.abs(h-expected)<1e-6);
 assert.equal(renderedHeightAtDirection(m,[-1,0,0]),null);
});

test('patch-local camera positions retain centimetre movement at Earth radius',()=>{
 const m=buildTile({face:0,level:16,x:40000,y:30000},{radius:R,gridSize:8,sampleHeight:height});
 const b=tileBounds(m.tile),d=faceDirection(0,(b.u0+b.u1)/2,(b.v0+b.v1)/2);
 const east=[-d[2],0,d[0]],len=Math.hypot(...east),t=east.map(x=>x/len);
 const camA=m.anchor.map((x,i)=>x+d[i]*2),camB=camA.map((x,i)=>x+t[i]*.01);
 const gpu=cam=>m.anchor.map((x,i)=>Math.fround(x-cam[i]));
 const a=gpu(camA),c=gpu(camB),measured=difference(c,a),want=t.map(x=>-x*.01);
 assert.ok(distance(measured,want)<1e-5);
 const naive=cam=>m.anchor.map((x,i)=>Math.fround(x)-Math.fround(cam[i]));
 assert.ok(distance(difference(naive(camB),naive(camA)),want)>.005);
 const h=renderedHeightAtDirection(m,d,0);assert.notEqual(h,null);
 assert.ok(Math.abs(h-height(d))<1e-3);
 for(let i=0;i<m.normals.length;i+=3)assert.ok(Math.abs(Math.hypot(...m.normals.slice(i,i+3))-1)<1e-6);
 assert.throws(()=>buildTile(m.tile,{radius:R,gridSize:8,sampleHeight:()=>NaN}));
});

test('selection remains balanced across a pole and cube corner with history',()=>{
 const dirs=[[0,1,0],[1,1,1].map(x=>x/Math.sqrt(3))];
 for(const d of dirs){const opts={...view(20,192),cameraPosition:d.map(x=>x*(R+1000)),viewDirection:d.map(x=>-x),cameraAltitude:20};
  const first=selectTiles(opts);assertCompleteBalanced(first.tiles,192);
  const second=selectTiles({...opts,previousKeys:new Set(first.tiles.map(tileKey))});assertCompleteBalanced(second.tiles,192);
 }
});


test('render-cut query cache detects address mutations instead of retaining stale neighbors',()=>{
 const cut=roots();assert.equal(getTileAtDirection(cut,[1,0,0]).face,0);
 const old=cut[0];cut.splice(0,1,...tileChildren(old));
 assert.equal(getTileAtDirection(cut,faceDirection(0,-.5,-.5)).level,1);
 assert.equal(edgeMask(cut.find(t=>t.face===0&&t.x===0&&t.y===0),cut),W|S);
 const left=cut.find(t=>t.face===0&&t.x===0&&t.y===0),right=cut.find(t=>t.face===0&&t.x===1&&t.y===0);
 // In-place swaps preserve both array identity and length.
 [left.x,right.x]=[right.x,left.x];
 assert.strictEqual(getTileAtDirection(cut,faceDirection(0,-.5,-.5)),right);
 assert.throws(()=>edgeMask({face:0,level:2,x:0,y:0},cut),/actual rendered/);
});


function nativeReference() {
 const base=new URL('../public/data/reference/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('manifest.json',base),'utf8'));
 const buffers=Object.fromEntries(Object.entries(manifest.fields).map(([key,f])=>{
  const bytes=readFileSync(new URL(f.file,base));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256,'bundled reference source changed without its manifest');
  return [key,Uint8Array.from(bytes).buffer];
 }));
 return new WorldData(manifest,buffers);
}
function nativeGroundView(world,maxTiles=320) {
 const lat=-8.4375*Math.PI/180,lon=55.3125*Math.PI/180;
 const radial=[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];
 const north=[-Math.sin(lat)*Math.cos(lon),Math.cos(lat),-Math.sin(lat)*Math.sin(lon)];
 const forward=radial.map((v,i)=>north[i]*Math.cos(-.12)+v*Math.sin(-.12));
 return {radial,north,options:{cameraPosition:radial.map(v=>v*(world.radius+world.sampleHeight(radial)+3)),cameraAltitude:3,
  viewDirection:forward,radius:world.radius,viewportHeight:900,fovY:52*Math.PI/180,pixelError:3,maxTiles,maxLevel:22,gridSize:24,
  sourceSpacing:world.sourceSpacing,heightRange:world.heightRange,sampleHeight:world.sampleHeight}};
}
function nativeRendered(world,tiles,dir) {
 const tile=getTileAtDirection(tiles,dir),mask=edgeMask(tile,tiles),mesh=buildTile(tile,{radius:world.radius,gridSize:24,sampleHeight:world.sampleHeight});
 const rendered=renderedHeightAtDirection(mesh,dir,mask);assert.notEqual(rendered,null);
 return {tile,rendered,error:Math.abs(rendered-world.sampleHeight(dir))};
}

test('native grid-knot navigation receives measured refinement and exposes an insufficient budget',()=>{
 const world=nativeReference(),v=nativeGroundView(world),small=selectTiles({...v.options,maxTiles:96});
 assertCompleteBalanced(small.tiles,96);
 const low=nativeRendered(world,small.tiles,v.radial);
 assert.ok(low.error>100,'this source point must retain the coarse-error regression');
 assert.equal(small.metrics.navigationSatisfied,false);assert.equal(small.metrics.navigationBudgetLimited,true);
 assert.equal(small.metrics.budgetLimited,true);
 assert.ok(Math.abs(low.error-small.metrics.navigationErrorM)<1e-6);
 const ready=selectTiles(v.options);assertCompleteBalanced(ready.tiles,320);
 assert.equal(ready.metrics.navigationSatisfied,true);assert.ok(ready.metrics.navigationErrorM<=.06);
 const measured=nativeRendered(world,ready.tiles,v.radial);
 assert.ok(measured.error<.1);assert.ok(Math.abs(measured.error-ready.metrics.navigationErrorM)<1e-6);
 // Camera movement stays within a refined local neighborhood; no special height
 // adjustment is used at the regression coordinate or these nearby positions.
 const east=[-Math.sin(55.3125*Math.PI/180),0,Math.cos(55.3125*Math.PI/180)];
 for(const [x,y] of [[-10,0],[10,0],[0,-10],[0,10]]){
  const raw=v.radial.map((d,i)=>d+(east[i]*x+v.north[i]*y)/world.radius),length=Math.hypot(...raw),dir=raw.map(d=>d/length);
  assert.ok(nativeRendered(world,ready.tiles,dir).error<.1,'near-camera source interpolation must remain within10cm');
 }
 const capped=selectTiles({...v.options,maxLevel:4});assertCompleteBalanced(capped.tiles,320);
 assert.equal(capped.metrics.navigationSatisfied,false);assert.equal(capped.metrics.navigationLevelLimited,true);
 assert.throws(()=>selectTiles({...v.options,navigationErrorM:0}),/navigation error/);
 assert.throws(()=>selectTiles({...v.options,sampleHeight:()=>NaN}),/navigation source/);
});

test('navigation reservation does not depend on looking toward the ground',()=>{
 const world=nativeReference(),v=nativeGroundView(world);
 const up=selectTiles({...v.options,viewDirection:v.radial});assertCompleteBalanced(up.tiles,320);
 assert.equal(up.metrics.navigationSatisfied,true);
 assert.ok(nativeRendered(world,up.tiles,v.radial).error<.1);
});

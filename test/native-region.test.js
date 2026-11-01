// Synthetic format fixtures test decoding and sampling, not native physics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { NativeRegion } from '../src/engine/NativeRegion.js';
globalThis.crypto ??= webcrypto;
const R=128,N=130,TAU=2*Math.PI,MODEL='planet-catchment-flow-hillslope/6';
const mod=(x,n)=>((x%n)+n)%n;
const sha=b=>createHash('sha256').update(new Uint8Array(b)).digest('hex');
const encode=x=>new TextEncoder().encode(JSON.stringify(x,null,2)).buffer;
const b3=x=>'blake3:'+x.repeat(64);
function fixture({rows=8,cols=16,rowStart=3,colStart=4,rowCount=2,colCount=2,value=(x,y)=>100+x*.5+y*2}={}) {
 const parent={schema:'maiforge.viewer-world/v1',id:'test-parent',seed:7,epochMy:4,radiusM:6371000,grid:{rows,cols},sourceArtifacts:{terrain:b3('1'),hydrology:b3('2')}};
 const source={input:{schema:'maiforge.native-endpoint/v1',seed:7,epochMy:4,radiusM:6371000,grid:[rows,cols],terrainArtifact:b3('1'),hydrologyArtifact:b3('2'),stratigraphy:b3('3'),subgridSha256:'4'.repeat(64)},hydrology:{artifact:b3('2')},initial_elevation_law:'native-centre-observations/monotone-c1/1'};
 const region={schema:'maiforge.viewer-native-region/v1',id:b3('5'),model:MODEL,seed:7,epochMy:4,radiusM:6371000,nativeGrid:[rows,cols],processGrid:[rows*R,cols*R],resolution:R,apron:1,sourceResolutionM:6371000*Math.PI/(rows*R),coarseRectangle:{rowStart,colStart,rowCount,colCount},sourceArtifacts:parent.sourceArtifacts,source,blocks:[]};
 const blocks=[];
 for(let y=0;y<rowCount;y++)for(let x=0;x<colCount;x++){
  const row=rowStart+y,col=mod(colStart+x,cols),cell=row*cols+col,origin=[col*R-1,row*R-1];
  const data=new ArrayBuffer(N*N*4),view=new DataView(data);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++)view.setFloat32((j*N+i)*4,value(mod(origin[0]+i,cols*R),Math.max(0,Math.min(rows*R-1,origin[1]+j))),true);
  const manifest={schema:'maiforge.native-process-block/v1',id:b3('6'),model:MODEL,cell,nativeGrid:[rows,cols],processGrid:[rows*R,cols*R],radiusM:6371000,resolution:R,apron:1,shape:[N,N],grid:{rows:N,cols:N,order:'south-first',sampling:'process-cell-centres'},originPost:origin,poleHeightM:[-20,30],sourceResolutionM:region.sourceResolutionM,source,
   fields:{elevation:{file:'height.f32',type:'f32le',unit:'m',bytes:data.byteLength,sha256:sha(data),maxQuantizationErrorM:0}}};
  blocks.push({cell,manifest,data});
 }
 const refresh=()=>{
  region.blocks=blocks.map(b=>({cell:b.cell,file:`blocks/cell-${b.cell}/manifest.json`,sha256:sha(encode(b.manifest))}));
  return {regionManifestBytes:encode(region),blocks:blocks.map(b=>({cell:b.cell,manifestBytes:encode(b.manifest),heightBytes:b.data.slice(0)}))};
 };
 return {parent,region,blocks,refresh,value};
}
const radians=(f,x,y)=>[(x/f.region.nativeGrid[1]-.5)*TAU,(y/f.region.nativeGrid[0]-.5)*Math.PI];
function expected(f,lon,lat){const [rows,cols]=f.region.nativeGrid;const x=mod((lon/TAU+.5)*cols*R-.5,cols*R),y=(lat/Math.PI+.5)*rows*R-.5;const i=Math.floor(x),j=Math.floor(y),fx=x-i,fy=y-j;const at=(i,j)=>f.value(mod(i,cols*R),Math.max(0,Math.min(rows*R-1,j)));return (1-fy)*((1-fx)*at(i,j)+fx*at(i+1,j))+fy*((1-fx)*at(i,j+1)+fx*at(i+1,j+1));}
function fetcher(f){
 const payload=f.refresh(),files=new Map([['/region/region.json',payload.regionManifestBytes]]);
 for(const b of payload.blocks){files.set(`/region/blocks/cell-${b.cell}/manifest.json`,b.manifestBytes);files.set(`/region/blocks/cell-${b.cell}/height.f32`,b.heightBytes);}
 return async url=>{const path=new URL(url).pathname;return files.has(path)?new Response(files.get(path).slice(0),{status:200}):new Response('missing',{status:404});};
}

test('load verifies native blocks and samples their unblended heights',async()=>{
 const f=fixture();const r=await NativeRegion.load('http://example.test/region/region.json',f.parent,{fetchImpl:fetcher(f)});
 const [lon,lat]=radians(f,4.35,3.42);assert.ok(Math.abs(r.sample(lon,lat)-expected(f,lon,lat))<1e-7);
 assert.equal(r.validation.blocks,4);assert.ok(r.validation.sharedNodeComparisons>0);assert.equal(r.parentId,f.parent.id);assert.equal(r.resolutionM,f.region.sourceResolutionM);
 assert.equal(r.sample(...radians(f,7,3.5)),null);assert.equal(r.contains(NaN,0),false);assert.equal(r.sample(0,Math.PI),null);
});

test('negative native ground is returned without water or coarse proxy substitution',async()=>{
 const f=fixture({value:()=>-12.5});const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 assert.equal(r.sample(r.centre.longitude,r.centre.latitude),-12.5);assert.deepEqual(r.heightRange,[-12.5,-12.5]);
});

test('shared cell boundaries and closed outer edges remain continuous',async()=>{
 const f=fixture({rows:288,cols:576,rowStart:31,colStart:151});const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 for(const x of [151,152,153])for(const y of [31,31.75,32,33]){const [lon,lat]=radians(f,x,y);assert.ok(r.contains(lon,lat));assert.ok(Math.abs(r.sample(lon,lat)-expected(f,lon,lat))<1e-6);}
 const [lon,lat]=radians(f,152,32);assert.ok(Math.abs(r.sample(lon-1e-12,lat)-r.sample(lon+1e-12,lat))<1e-5);
});

test('antimeridian coverage is periodic without accepting the opposite hemisphere',async()=>{
 const f=fixture({colStart:15});const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 for(const lon of [Math.PI-.01,Math.PI,Math.PI+.01,-Math.PI]){assert.ok(r.contains(lon,0));assert.ok(Math.abs(r.sample(lon,0)-expected(f,lon,0))<1e-6);assert.ok(Math.abs(r.sample(lon+TAU,0)-r.sample(lon,0))<1e-6);}
 assert.equal(r.contains(0,0),false);
});

test('polar cap converges to the declared single pole value',async()=>{
 const f=fixture({rowStart:0});const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 assert.equal(r.sample(2.4,-Math.PI/2),-20);assert.equal(r.sample(-2.4,-Math.PI/2),-20);assert.ok(r.heightRange[0]<=-20);
 assert.equal(r.distanceToBoundaryM(1,-Math.PI/2),0);
});

test('boundary distances are in metres and keep each edge for a smooth guard',async()=>{
 const f=fixture();const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 const [west,lat]=radians(f,4,4);assert.equal(r.distanceToBoundaryM(west,lat),0);
 const distance=r.distanceToBoundaryM(r.centre.longitude,r.centre.latitude);assert.ok(Math.abs(distance-r.radiusM*Math.PI/8)<1e-6);
 const d=r.boundaryDistancesM(r.centre.longitude,r.centre.latitude);assert.ok(Object.values(d).every(x=>x>0));assert.ok(Object.isFrozen(d));
 assert.equal(r.distanceToBoundaryM(...radians(f,7,4)),0);
});

test('native buffers and metadata are immutable despite payload mutation/transfer',async()=>{
 const f=fixture();const payload=f.refresh();const promise=NativeRegion.fromPayload(payload,f.parent);
 new Uint8Array(payload.blocks[0].heightBytes).fill(0);const r=await promise;const point=[r.centre.longitude,r.centre.latitude],z=r.sample(...point);
 assert.throws(()=>{r.centre.latitude=0;},TypeError);assert.throws(()=>{r.manifest.source.seed=2;},TypeError);
 const p=r.workerPayload();const transfer=[p.regionManifestBytes,...p.blocks.flatMap(b=>[b.manifestBytes,b.heightBytes])];const moved=structuredClone(p,{transfer});
 assert.equal(p.regionManifestBytes.byteLength,0);const other=await NativeRegion.fromPayload(moved,f.parent);assert.equal(other.sample(...point),z);
 new Uint8Array(moved.blocks[0].heightBytes).fill(0);assert.equal(r.sample(...point),z);assert.equal(other.sample(...point),z);
});

test('wrong parent pin, source model and block grid are rejected',async()=>{
 const f=fixture();await assert.rejects(()=>NativeRegion.fromPayload(f.refresh(),{...f.parent,sourceArtifacts:{...f.parent.sourceArtifacts,terrain:b3('a')}}),/source pin/);
 f.blocks[0].manifest.model='different-model';await assert.rejects(()=>NativeRegion.fromPayload(f.refresh(),f.parent),/block shape\/model/);
 f.blocks[0].manifest.model=MODEL;f.blocks[0].manifest.originPost[0]++;await assert.rejects(()=>NativeRegion.fromPayload(f.refresh(),f.parent),/origin/);
});

test('a missing block is not replaced by coarse or zero data',async()=>{
 const f=fixture();const p=f.refresh();p.blocks.pop();await assert.rejects(()=>NativeRegion.fromPayload(p,f.parent),/incomplete/);
 const p2=f.refresh();const m=JSON.parse(new TextDecoder().decode(p2.regionManifestBytes));m.blocks[1]=m.blocks[0];p2.regionManifestBytes=encode(m);await assert.rejects(()=>NativeRegion.fromPayload(p2,f.parent),/duplicate/);
});

test('tampered bytes fail hashing even when the declared model looks valid',async()=>{
 const f=fixture();const p=f.refresh();new Uint8Array(p.blocks[0].heightBytes)[100]^=1;await assert.rejects(()=>NativeRegion.fromPayload(p,f.parent),/height hash/);
 const p2=f.refresh();new Uint8Array(p2.blocks[0].manifestBytes)[10]^=1;await assert.rejects(()=>NativeRegion.fromPayload(p2,f.parent),/manifest hash/);
});

test('finite values and shared apron equality are checked beyond hashes',async()=>{
 const f=fixture();new DataView(f.blocks[1].data).setFloat32(64*N*4,9999,true);f.blocks[1].manifest.fields.elevation.sha256=sha(f.blocks[1].data);
 await assert.rejects(()=>NativeRegion.fromPayload(f.refresh(),f.parent),/apron/);
 const g=fixture();new DataView(g.blocks[0].data).setFloat32((50*N+50)*4,NaN,true);g.blocks[0].manifest.fields.elevation.sha256=sha(g.blocks[0].data);
 await assert.rejects(()=>NativeRegion.fromPayload(g.refresh(),g.parent),/nonfinite/);
});

test('unsafe resource paths and wrong role encodings are refused',async()=>{
 const f=fixture();const p=f.refresh();const m=JSON.parse(new TextDecoder().decode(p.regionManifestBytes));m.blocks[0].file='../escape/manifest.json';p.regionManifestBytes=encode(m);
 await assert.rejects(()=>NativeRegion.fromPayload(p,f.parent),/unsafe/);
 f.blocks[0].manifest.fields.elevation.type='f64le';await assert.rejects(()=>NativeRegion.fromPayload(f.refresh(),f.parent),/solid-height/);
});

test('render composition preserves raw samples and interpolates node-owner water stages',async()=>{
 const f=fixture({value:()=>-12.5});const r=await NativeRegion.fromPayload(f.refresh(),f.parent);
 const [lon,lat]=radians(f,f.region.coarseRectangle.colStart+1,f.region.coarseRectangle.rowStart+.5);
 const cols=f.region.nativeGrid[1],left=f.region.coarseRectangle.rowStart*cols+f.region.coarseRectangle.colStart;
 assert.equal(r.sampleRenderSurface(lon,lat,h=>h),r.sample(lon,lat));
 const composed=r.sampleRenderSurface(lon,lat,(h,owner)=>owner===left?100:200);
 assert.ok(Math.abs(composed-150)<1e-8);
 assert.equal(r.sample(lon,lat),-12.5);
 assert.throws(()=>r.sampleRenderSurface(lon,lat,()=>NaN),/render node/);
});

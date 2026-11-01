// Small synthetic format fixtures: decoder/interpolation checks, not native physics.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {NativeProxy} from '../src/engine/NativeProxy.js';
globalThis.crypto??=webcrypto;
const TAU=2*Math.PI,rad=x=>x*Math.PI/180,b3=x=>'blake3:'+x.repeat(64);
const encode=x=>new TextEncoder().encode(JSON.stringify(x)).buffer;
const sha=x=>createHash('sha256').update(new Uint8Array(x)).digest('hex');
function fixture(){
 const parent={schema:'maiforge.viewer-world/v1',id:'test-parent',seed:7,epochMy:4,radiusM:6371000,grid:{rows:8,cols:16},sourceArtifacts:{terrain:b3('1'),hydrology:b3('2')}};
 const rowIndices=[0,3,7],colIndices=[0,3,8,14],values=rowIndices.flatMap(r=>colIndices.map(c=>-37+13*r+7*c));
 const bytes=new ArrayBuffer(values.length*4),dv=new DataView(bytes);values.forEach((v,i)=>dv.setFloat32(i*4,v,true));
 const source={input:{schema:'maiforge.native-endpoint/v1',seed:7,epochMy:4,radiusM:6371000,grid:[8,16],terrainArtifact:b3('1'),hydrologyArtifact:b3('2'),stratigraphy:b3('3'),subgridSha256:'4'.repeat(64)},hydrology:{artifact:b3('2')},initial_elevation_law:'native-centre-observations/monotone-c1/1'};
 const m={schema:'maiforge.viewer-native-proxy/v1',model:'planet-catchment-flow-hillslope/6',id:b3('5'),source,seed:7,radiusM:6371000,nativeGrid:[8,16],controlGrid:[3,4],rowIndices,colIndices,
  latitudeDegrees:rowIndices.map(r=>-90+(r+.5)*180/8),longitudeDegrees:colIndices.map(c=>-180+(c+.5)*360/16),
  grid:{order:'south-first',layout:'row-major',sampling:'native coarse-cell centres nearest regular control targets; exact coordinates above'},
  sourceResolutionM:6371000*Math.PI/(8*128),predictor:'native endpoint datum: cell-centred bilinear with native pole-row means',
  interpolation:'render-only: bilinear residual between the declared latitude/longitude controls, periodic longitude; outer control row blends linearly to declared pole residual',
  poleSamples:[{latitudeDegrees:-90,longitudeDegrees:-168.75,nativeM:-623,datumM:-500,residualM:-123},{latitudeDegrees:90,longitudeDegrees:11.25,nativeM:706,datumM:250,residualM:456}],
  fields:{residual:{file:'residual.f32',type:'f32le',unit:'m',bytes:bytes.byteLength,sha256:sha(bytes),maxQuantizationErrorM:0}},maximumCanonicalReplayDifferenceM:0,
  qualification:'Synthetic raw residual fixture; not physics/collision authority.'};
 return {parent,m,bytes,values,payload:()=>({proxyManifestBytes:encode(m),residualBytes:bytes.slice(0)})};
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} differs from ${b}`);
function fetcher(f,alter=()=>{}){
 const calls=[];
 return {calls,fetchImpl:async(url,opts)=>{
  calls.push({url:String(url),opts});const path=new URL(url).pathname;
  if(path==='/proxy/proxy.json')return new Response(encode(f.m),{status:200});
  if(path==='/proxy/residual.f32'){const b=f.bytes.slice(0);alter(b);return new Response(b,{status:200});}
  return new Response('missing',{status:404});
 }};
}

test('proxy returns raw controls at their declared native coordinates and nonuniform bilinear intervals',async()=>{
 const f=fixture(),p=await NativeProxy.fromPayload(f.payload(),f.parent);
 assert.equal(p.id,f.m.id);assert.equal(p.model,f.m.model);assert.equal(p.parentId,f.parent.id);assert.deepEqual(p.heightRangeResidual,[-123,456]);
 for(let y=0;y<3;y++)for(let x=0;x<4;x++)near(p.sampleResidual(rad(f.m.longitudeDegrees[x]),rad(f.m.latitudeDegrees[y])),f.values[y*4+x]);
 const x=2,y=1,fx=.3,fy=.4,lon=rad(f.m.longitudeDegrees[x]*(1-fx)+f.m.longitudeDegrees[x+1]*fx),lat=rad(f.m.latitudeDegrees[y]*(1-fy)+f.m.latitudeDegrees[y+1]*fy);
 const row=r=>f.values[r*4+x]*(1-fx)+f.values[r*4+x+1]*fx;
 near(p.sampleResidual(lon,lat),row(y)*(1-fy)+row(y+1)*fy);
 assert.ok(p.sampleResidual(rad(f.m.longitudeDegrees[0]),rad(f.m.latitudeDegrees[0]))<0,'negative residual must not be clamped or replaced by datum');
});

test('periodic longitude uses the actual final-to-first interval and caps use explicit nonzero poles',async()=>{
 const f=fixture(),p=await NativeProxy.fromPayload(f.payload(),f.parent),lat=rad(f.m.latitudeDegrees[1]);
 const left=f.m.longitudeDegrees.at(-1),right=f.m.longitudeDegrees[0]+360,t=(180-left)/(right-left),want=f.values[7]*(1-t)+f.values[4]*t;
 near(p.sampleResidual(Math.PI,lat),want);near(p.sampleResidual(-Math.PI,lat),want);
 near(p.sampleResidual(.8+TAU,lat),p.sampleResidual(.8,lat));
 for(const lon of [-Math.PI,-1,0,1,Math.PI]){assert.equal(p.sampleResidual(lon,-Math.PI/2),-123);assert.equal(p.sampleResidual(lon,Math.PI/2),456);}
 const lon=rad(f.m.longitudeDegrees[2]);
 near(p.sampleResidual(lon,rad((-90+f.m.latitudeDegrees[0])/2)),(-123+f.values[2])/2);
 near(p.sampleResidual(lon,rad((90+f.m.latitudeDegrees[2])/2)),(456+f.values[10])/2);
 assert.equal(p.sampleResidual(NaN,0),null);assert.equal(p.sampleResidual(0,Math.PI),null);
});

test('proxy owns immutable input snapshots and transferable worker copies',async()=>{
 const f=fixture(),payload=f.payload(),pending=NativeProxy.fromPayload(payload,f.parent);
 new Uint8Array(payload.proxyManifestBytes).fill(0);new Uint8Array(payload.residualBytes).fill(0);
 const p=await pending,lon=rad(f.m.longitudeDegrees[0]),lat=rad(f.m.latitudeDegrees[0]);near(p.sampleResidual(lon,lat),-37);
 assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.manifest.rowIndices));
 assert.throws(()=>{p.manifest.rowIndices[0]=2;},TypeError);
 const copy=p.workerPayload();new DataView(copy.residualBytes).setFloat32(0,999,true);near(p.sampleResidual(lon,lat),-37);
 const pristine=p.workerPayload(),received=structuredClone(pristine,{transfer:[pristine.proxyManifestBytes,pristine.residualBytes]});assert.equal(pristine.residualBytes.byteLength,0);
 const rebuilt=await NativeProxy.fromPayload(received,f.parent);near(rebuilt.sampleResidual(lon,lat),-37);
});

test('proxy refuses shape, coordinate and missing-pole substitutions',async()=>{
 const mutations=[m=>m.controlGrid=[2,4],m=>m.rowIndices[1]=m.rowIndices[0],m=>m.colIndices.reverse(),m=>m.latitudeDegrees[1]+=.3125,m=>m.longitudeDegrees[2]-=.3125,m=>m.rowIndices[2]=8,m=>m.poleSamples.pop(),m=>m.poleSamples[1].latitudeDegrees=-90,m=>m.poleSamples[0].residualM=0,m=>m.fields.residual.file='../residual.f32',m=>m.fields.residual.bytes+=4,m=>m.fields.residual.type='u8'];
 for(const mutate of mutations){const f=fixture();mutate(f.m);await assert.rejects(()=>NativeProxy.fromPayload(f.payload(),f.parent),/Native proxy:/);}
});

test('proxy refuses mismatched native source, model, identity and parent metadata',async()=>{
 const changes=[p=>p.seed++,p=>p.epochMy++,p=>p.radiusM++,p=>p.grid.rows++,p=>p.sourceArtifacts.terrain=b3('a'),p=>p.sourceArtifacts.hydrology=b3('b')];
 for(const change of changes){const f=fixture();change(f.parent);await assert.rejects(()=>NativeProxy.fromPayload(f.payload(),f.parent),/mismatch/);}
 for(const change of [m=>m.model='planet-catchment-flow-hillslope/5',m=>m.id='not-a-content-id',m=>m.source.input.terrainArtifact=b3('a'),m=>m.source.hydrology.artifact=b3('b'),m=>m.source.initial_elevation_law='different-law',m=>m.sourceResolutionM*=2]){
  const f=fixture();change(f.m);await assert.rejects(()=>NativeProxy.fromPayload(f.payload(),f.parent),/Native proxy:/);
 }
});

test('residual SHA and finite samples are checked without zero repair',async()=>{
 let f=fixture(),p=f.payload();new Uint8Array(p.residualBytes)[0]^=1;
 await assert.rejects(()=>NativeProxy.fromPayload(p,f.parent),/hash\/length/);
 f=fixture();new DataView(f.bytes).setFloat32(0,NaN,true);f.m.fields.residual.sha256=sha(f.bytes);
 await assert.rejects(()=>NativeProxy.fromPayload(f.payload(),f.parent),/nonfinite/);
 f=fixture();p=f.payload();p.residualBytes=p.residualBytes.slice(0,-4);
 await assert.rejects(()=>NativeProxy.fromPayload(p,f.parent),/hash\/length/);
});

test('async proxy load verifies the resource and stays within anonymous local resource requests',async()=>{
 const f=fixture(),mock=fetcher(f),p=await NativeProxy.load('https://example.test/proxy/proxy.json',f.parent,{fetchImpl:mock.fetchImpl});
 near(p.sampleResidual(rad(f.m.longitudeDegrees[0]),rad(f.m.latitudeDegrees[0])),-37);assert.equal(mock.calls.length,2);
 for(const call of mock.calls){assert.equal(call.opts.credentials,'omit');assert.equal(call.opts.redirect,'error');assert.equal(call.opts.referrerPolicy,'no-referrer');}
 const corrupt=fetcher(f,b=>{new Uint8Array(b)[0]^=1;});await assert.rejects(()=>NativeProxy.load('https://example.test/proxy/proxy.json',f.parent,{fetchImpl:corrupt.fetchImpl}),/hash\/length/);
 await assert.rejects(()=>NativeProxy.load('https://user:pass@example.test/proxy.json',f.parent,{fetchImpl:mock.fetchImpl}),/without credentials/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorldData } from '../src/engine/WorldData.js';

function fixture() {
  const rows=4,cols=4;
  const scalar=Float32Array.from({length:16},(_,i)=>100*Math.floor(i/cols)+10*(i%cols));
  const arrays={elevation:scalar,surfaceHeight:scalar.slice(),lithology:Uint8Array.from({length:16},(_,i)=>(i%cols)*2),waterKind:new Uint8Array(16)};
  const buffers=Object.fromEntries(Object.entries(arrays).map(([k,a])=>[k,a.buffer]));
  const fields=Object.fromEntries(Object.entries(arrays).map(([k,a])=>[k,{type:a instanceof Float32Array?'f32le':'u8',file:k+(a instanceof Float32Array?'.f32':'.u8'),bytes:a.byteLength,sha256:createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex'),unit:a instanceof Float32Array?'m':'code'}]));
  const manifest={schema:'maiforge.viewer-world/v1',id:'sha256:'+'a'.repeat(64),radiusM:6371000,sourceResolutionM:6371000*Math.PI/rows,
    grid:{rows,cols,order:'south-first'},interpolation:'cell-centred-bilinear-pole-mean',fields};
  return {manifest,buffers};
}
function replaceField(f,key,type,values) {
  const array=type==='f32le'?Float32Array.from(values):Uint8Array.from(values);
  f.buffers[key]=array.buffer;
  f.manifest.fields[key]={...f.manifest.fields[key],type,bytes:array.byteLength,
    sha256:createHash('sha256').update(new Uint8Array(array.buffer)).digest('hex')};
}
function memoryFetch(f, alter=()=>{}) {
  const requests=[];
  const fetchImpl=async (url,options)=>{
    const u=new URL(url);requests.push({url:u.href,options});
    if(u.pathname.endsWith('/manifest.json'))return new Response(JSON.stringify(f.manifest),{status:200});
    const entry=Object.entries(f.manifest.fields).find(([,d])=>u.pathname.endsWith('/'+d.file));
    if(!entry)return new Response('missing',{status:404});
    const [key]=entry;const bytes=f.buffers[key].slice(0);alter(key,bytes);
    return new Response(bytes,{status:200});
  };
  return {fetchImpl,requests};
}

test('required source roles reject valid-length data encoded with the wrong type',()=>{
  for(const key of ['elevation','surfaceHeight','lithology','waterKind']){
    const f=fixture(),wrong=f.manifest.fields[key].type==='u8'?'f32le':'u8';
    replaceField(f,key,wrong,new Array(16).fill(0));
    assert.throws(()=>new WorldData(f.manifest,f.buffers),/role encoding/);
  }
  const missing=fixture();delete missing.manifest.fields.surfaceHeight;delete missing.buffers.surfaceHeight;
  assert.throws(()=>new WorldData(missing.manifest,missing.buffers),/required source role/);
});

test('source identity, resolution and grid are validated before use',()=>{
  for(const id of [undefined,'','   ','x'.repeat(257)]){
    const f=fixture();f.manifest.id=id;assert.throws(()=>new WorldData(f.manifest,f.buffers),/identity\/resolution/);
  }
  for(const spacing of [0,-1,Infinity,NaN]){
    const f=fixture();f.manifest.sourceResolutionM=spacing;assert.throws(()=>new WorldData(f.manifest,f.buffers),/identity\/resolution/);
  }
  for(const [rows,cols] of [[-4,-4],[4,4.5],[2,4],[4096,4096]]){
    const f=fixture();f.manifest.grid.rows=rows;f.manifest.grid.cols=cols;assert.throws(()=>new WorldData(f.manifest,f.buffers),/grid/);
  }
  for(const file of ['.','..','../field.f32','https://example.test/x']){
    const f=fixture();f.manifest.fields.elevation.file=file;assert.throws(()=>new WorldData(f.manifest,f.buffers),/descriptor/);
  }
});

test('continuous fields match native centres, wrap longitude and converge to pole means',()=>{
  const f=fixture(),w=new WorldData(f.manifest,f.buffers),close=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
  const lon=c=>((c+.5)/4-.5)*Math.PI*2,lat=r=>((r+.5)/4-.5)*Math.PI;
  for(let r=0;r<4;r++)for(let c=0;c<4;c++)close(w.sampleField('elevation',lon(c),lat(r)),r*100+c*10);
  close(w.sampleField('elevation',-Math.PI,lat(1)),115);
  close(w.sampleField('elevation',Math.PI,lat(1)),115);
  close(w.sampleField('elevation',.37,lat(2)),w.sampleField('elevation',.37+4*Math.PI,lat(2)));
  for(const x of [-Math.PI,-1,0,1,Math.PI]){
    close(w.sampleField('surfaceHeight',x,-Math.PI/2),15);
    close(w.sampleField('surfaceHeight',x,Math.PI/2),315);
  }
  close(w.sampleField('surfaceHeight',lon(0),-Math.PI/2+Math.PI/16),7.5);
  close(w.sampleField('surfaceHeight',lon(0),Math.PI/2-Math.PI/16),307.5);
  const nearPole=[-2,-1,0,1,2].map(x=>w.sampleField('surfaceHeight',x,Math.PI/2-1e-9));
  assert.ok(Math.max(...nearPole)-Math.min(...nearPole)<1e-6);
  // Categorical lithology remains an actual source code, never an averaged1.
  assert.equal(w.sampleField('lithology',-Math.PI/2,lat(0)),2);
  assert.equal(w.sampleField('absent',0,0),null);
});

test('invalid native values and water stages are refused without inventing a repair',()=>{
  let f=fixture();new Float32Array(f.buffers.elevation)[0]=NaN;
  assert.throws(()=>new WorldData(f.manifest,f.buffers),/Nonfinite/);
  f=fixture();new Uint8Array(f.buffers.waterKind)[0]=3;
  assert.throws(()=>new WorldData(f.manifest,f.buffers),/water kind/);
  f=fixture();new Uint8Array(f.buffers.waterKind)[1]=1;new Float32Array(f.buffers.surfaceHeight)[1]=-1;
  assert.throws(()=>new WorldData(f.manifest,f.buffers),/below the ground/);
});

test('async load verifies real field hashes and reports completed field progress',async()=>{
  const f=fixture(),memory=memoryFetch(f),progress=[];
  const w=await WorldData.load('https://example.test/data/manifest.json',{fetchImpl:memory.fetchImpl,onProgress:v=>progress.push(v)});
  assert.equal(w.id,f.manifest.id);assert.deepEqual(w.heightRange,[0,330]);
  assert.equal(progress.length,4);assert.equal(progress.at(-1),1);
  assert.equal(memory.requests.length,5);
  for(const req of memory.requests)assert.equal(req.options.credentials,'omit');
  const corrupt=memoryFetch(f,(key,bytes)=>{if(key==='surfaceHeight')new Uint8Array(bytes)[1]^=1;});
  await assert.rejects(()=>WorldData.load('https://example.test/data/manifest.json',{fetchImpl:corrupt.fetchImpl}),/source hash/);
  const wrong=fixture();replaceField(wrong,'elevation','u8',new Array(16).fill(0));const bad=memoryFetch(wrong);
  await assert.rejects(()=>WorldData.load('https://example.test/data/manifest.json',{fetchImpl:bad.fetchImpl}),/role encoding/);
  assert.equal(bad.requests.length,1,'invalid manifest must fail before field downloads');
});

test('worker payload copies buffers so transfer or edits cannot detach the primary source',()=>{
  const f=fixture(),world=new WorldData(f.manifest,f.buffers),payload=world.workerPayload();
  for(const key of Object.keys(f.buffers)){assert.notStrictEqual(payload.buffers[key],f.buffers[key]);assert.equal(payload.buffers[key].byteLength,f.buffers[key].byteLength);}
  new Float32Array(payload.buffers.surfaceHeight)[0]=999;
  assert.equal(world.fields.surfaceHeight[0],0);
  const transferred=structuredClone(payload,{transfer:Object.values(payload.buffers)});
  assert.equal(payload.buffers.elevation.byteLength,0);
  assert.equal(world.fields.elevation.byteLength,64);
  assert.equal(new Float32Array(transferred.buffers.surfaceHeight)[0],999);
});

test('optional render proxy uses explicit pole residuals and requires the correct parent',()=>{
 // Presentation composition only. Synthetic controls do not validate native physics.
 const f=fixture(),source={input:{a:1,b:2}};
 const nativeRegion={id:'region',parentId:f.manifest.id,manifest:{model:'test',source},resolutionM:500,heightRange:[0,100],contains:()=>false};
 const nativeProxy={id:'proxy',parentId:f.manifest.id,manifest:{model:'test',source:{input:{b:2,a:1}}},sampleResidual:(_lon,lat)=>Math.abs(lat)===Math.PI/2?(lat<0?71:-23):0};
 const w=new WorldData(f.manifest,f.buffers,{nativeRegion,nativeProxy});
 assert.equal(w.sampleHeight([0,-1,0]),15+71);
 assert.equal(w.sampleHeight([0,1,0]),315-23);
 assert.throws(()=>new WorldData(f.manifest,f.buffers,{nativeRegion:{...nativeRegion,parentId:'other'},nativeProxy}),/parent identity/);
 assert.throws(()=>new WorldData(f.manifest,f.buffers,{nativeRegion,nativeProxy:{...nativeProxy,manifest:{model:'test',source:{input:{a:9}}}}}),/source mismatch/);
});

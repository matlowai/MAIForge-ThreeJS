import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

function fixture(id,height=100) {
  const values={elevation:new Float32Array(16).fill(height),surfaceHeight:new Float32Array(16).fill(height),lithology:new Uint8Array(16),waterKind:new Uint8Array(16)};
  const fields=Object.fromEntries(Object.entries(values).map(([k,a])=>[k,{type:a instanceof Float32Array?'f32le':'u8',file:k+'.data',bytes:a.byteLength,
    sha256:createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex'),unit:a instanceof Float32Array?'m':'code'}]));
  return {manifest:{schema:'maiforge.viewer-world/v1',id,radiusM:6371000,sourceResolutionM:5000000,
    grid:{rows:4,cols:4,order:'south-first'},interpolation:'cell-centred-bilinear-pole-mean',fields},
    buffers:Object.fromEntries(Object.entries(values).map(([k,a])=>[k,a.buffer]))};
}
function nextMessage(worker) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);worker.off('message',onMessage);worker.off('error',onError);worker.off('exit',onExit);};
    const onMessage=m=>{cleanup();resolve(m);},onError=e=>{cleanup();reject(e);},onExit=c=>{cleanup();reject(Error(`Worker exited before reply: ${c}`));};
    const timer=setTimeout(()=>{cleanup();reject(Error('Worker reply timed out'));},5000);
    worker.once('message',onMessage);worker.once('error',onError);worker.once('exit',onExit);
  });
}
async function startWorker(t) {
  const module=new URL('../src/engine/terrain.worker.js',import.meta.url).href;
  // Exercise the actual browser worker module; only the host message bridge is
  // adapted to Node. No worker algorithm or protocol is reimplemented here.
  const bootstrap=`import {parentPort} from 'node:worker_threads';
    globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};
    await import(${JSON.stringify(module)});
    parentPort.on('message',data=>self.onmessage({data}));
    parentPort.postMessage({type:'test-bootstrap-ready'});`;
  const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(bootstrap)),{type:'module'});
  t.after(()=>worker.terminate());
  assert.equal((await nextMessage(worker)).type,'test-bootstrap-ready');
  return {async send(message,transfer=[]){const pending=nextMessage(worker);worker.postMessage(message,transfer);return pending;}};
}
const tile={face:0,level:12,x:2048,y:2048};

test('worker refuses uninitialized and stale-source tile requests, returns bound geometry',async t=>{
  const w=await startWorker(t);
  let reply=await w.send({type:'tile',id:1,sourceId:'world-a',tile,gridSize:4});
  assert.equal(reply.type,'error');assert.equal(reply.sourceId,null);
  const f=fixture('world-a');reply=await w.send({type:'init',...f},Object.values(f.buffers));
  assert.deepEqual(reply,{type:'ready',sourceId:'world-a'});
  reply=await w.send({type:'tile',id:2,sourceId:'world-old',tile,gridSize:4});
  assert.equal(reply.type,'error');assert.equal(reply.id,2);assert.match(reply.message,/mismatched/);
  reply=await w.send({type:'tile',id:3,sourceId:'world-a',tile,gridSize:4});
  assert.equal(reply.type,'tile');assert.equal(reply.sourceId,'world-a');assert.equal(reply.id,3);
  assert.equal(reply.result.radius,6371000);assert.deepEqual(reply.result.tile,tile);
  assert.ok(reply.result.positions instanceof Float32Array);assert.equal(reply.result.positions.length,75);
  for(const key of ['positionHigh','positionLow']){assert.ok(reply.result[key] instanceof Float32Array);assert.equal(reply.result[key].length,75);}
  for(let k=0;k<3;k++)assert.ok(Math.abs(reply.result.positionHigh[36+k]+reply.result.positionLow[36+k]-reply.result.anchor[k])<1e-7);
  assert.ok(Math.abs(Math.hypot(...reply.result.anchor)-6371100)<1e-6);
});

test('failed worker init clears the previous source instead of serving old geometry',async t=>{
  const w=await startWorker(t);await w.send({type:'init',...fixture('world-a')});
  const invalid=fixture('world-invalid');invalid.manifest.fields.elevation.type='u8';
  let reply=await w.send({type:'init',...invalid});
  assert.equal(reply.type,'error');assert.equal(reply.sourceId,null);
  reply=await w.send({type:'tile',id:4,sourceId:'world-a',tile,gridSize:4});
  assert.equal(reply.type,'error');assert.equal(reply.sourceId,null);assert.match(reply.message,/not initialized/);
  reply=await w.send({type:'init',...fixture('world-b',600)});assert.equal(reply.sourceId,'world-b');
  reply=await w.send({type:'tile',id:5,sourceId:'world-b',tile,gridSize:4});
  assert.equal(reply.type,'tile');assert.ok(Math.abs(Math.hypot(...reply.result.anchor)-6371600)<1e-6);
});

test('successful source replacement rejects the old source even when request IDs are reused',async t=>{
  const w=await startWorker(t);await w.send({type:'init',...fixture('world-a')});
  await w.send({type:'init',...fixture('world-b',600)});
  let reply=await w.send({type:'tile',id:7,sourceId:'world-a',tile,gridSize:4});
  assert.equal(reply.type,'error');assert.equal(reply.sourceId,'world-b');
  reply=await w.send({type:'tile',id:7,sourceId:'world-b',tile,gridSize:4});
  assert.equal(reply.type,'tile');assert.equal(reply.sourceId,'world-b');assert.equal(reply.id,7);
});

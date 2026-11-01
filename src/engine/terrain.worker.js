import { WorldData } from './WorldData.js';
import { NativeRegion } from './NativeRegion.js';
import { NativeProxy } from './NativeProxy.js';
import { buildTile } from '../terrain/mesh.js';
let source,generation=0;
self.onmessage=async event=>{
 const m=event.data;
 try{
  if(m.type==='init'){
   const token=++generation;source=null;
   try {
    const [nativeRegion,nativeProxy]=await Promise.all([
      m.nativeRegion?NativeRegion.fromPayload(m.nativeRegion,m.manifest):null,
      m.nativeProxy?NativeProxy.fromPayload(m.nativeProxy,m.manifest):null]);
    if(token!==generation)return;
    source=new WorldData(m.manifest,m.buffers,{nativeRegion,nativeProxy});
    self.postMessage({type:'ready',sourceId:source.id});
   } catch(e){if(token===generation)self.postMessage({type:'error',sourceId:null,message:e.message});}
   return;
  }
  if(m.type==='tile'){
   if(!source||m.sourceId!==source.id)throw Error('Source not initialized or mismatched');
   const result=buildTile(m.tile,{radius:source.radius,gridSize:m.gridSize,sampleHeight:source.sampleHeight,normalStep:25});
   const transfer=[result.positions.buffer,result.normals.buffer,result.planetPositions.buffer,result.positionHigh.buffer,result.positionLow.buffer];
   self.postMessage({type:'tile',id:m.id,sourceId:source.id,result},transfer);
  }
 }catch(e){self.postMessage({type:'error',id:m.id,sourceId:source?.id??null,message:e.message});}
};

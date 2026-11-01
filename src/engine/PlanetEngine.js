import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { WorldData } from './WorldData.js';
import { GeoCamera } from './GeoCamera.js';
import { createTerrainMaterial,createWorldTextures,createAtmosphere } from './materials.js';
import { tileKey,tileChildren } from '../terrain/cube.js';
import { selectTiles,balanceByCoarsening,edgeMask,getTileAtDirection } from '../terrain/lod.js';
import { indicesForMask,renderedHeightAtDirection } from '../terrain/mesh.js';
const roots=()=>Array.from({length:6},(_,face)=>({face,level:0,x:0,y:0}));
const mod=(x,n)=>((x%n)+n)%n;
const qualities={low:{tiles:320,error:3,pixelRatio:.8,detail:0,cache:64},balanced:{tiles:384,error:1.6,pixelRatio:1.5,detail:1,cache:80},high:{tiles:512,error:.9,pixelRatio:2,detail:1,cache:112}};

/** Browser engine adapter. Owns representation/input, never native world state. */
export class PlanetEngine extends EventTarget {
  constructor(canvas,{onStats=()=>{},onError=()=>{}}={}) {
    super();this.canvas=canvas;this.onStats=onStats;this.onError=onError;
    this.renderer=new THREE.WebGLRenderer({canvas,antialias:false,powerPreference:'high-performance',logarithmicDepthBuffer:true,reversedDepthBuffer:true});
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.05;
    this.scene=new THREE.Scene();this.spaceColor=new THREE.Color('#071019');this.airColor=new THREE.Color('#8da9b8');this.scene.background=this.spaceColor.clone();this.camera=new THREE.PerspectiveCamera(52,1,.02,4e7);
    // A single-sample terrain pass avoids an observed intermittent MSAA seam.
    // FXAA follows tone mapping/sRGB conversion; source geometry is unchanged.
    this.composer=new EffectComposer(this.renderer);
    this.renderPass=new RenderPass(this.scene,this.camera);this.outputPass=new OutputPass();this.fxaaPass=new FXAAPass();
    this.composer.addPass(this.renderPass);this.composer.addPass(this.outputPass);this.composer.addPass(this.fxaaPass);
    this.renderer.info.autoReset=false;
    this.rootGroup=new THREE.Group();this.scene.add(this.rootGroup);this.raycaster=new THREE.Raycaster();
    const gl=this.renderer.getContext(), ext=gl.getExtension('WEBGL_debug_renderer_info');
    this.gpu=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'WebGL2';
    this.software=/swiftshader|llvmpipe|software/i.test(this.gpu);this.qualityName=this.software?'low':'balanced';
    this.gridSize=24;this.cache=new Map();this.pending=new Map();this.queue=[];this.workers=[];this.rendered=[];this.desired=roots();this.branches=new Set();
    this.cacheBudget=48*1024*1024;this.maxCacheTiles=1400;this.generatedTiles=0;this.tileErrors=0;this.serial=0;this.tick=0;this.cutDirty=false;
    this.frameTimes=[];this.lastFrame=0;this.lastStats=0;this.lastPlan=0;this.planDirty=true;this.disposed=false;this.running=false;
    this.lastPlanPose=null;this.currentPose=null;this.plannerMs=0;this.masksMs=0;this.mode='climate';this.autoOrbit=false;
    this.resizeObserver=new ResizeObserver(()=>{this.resize();this.planDirty=true;});this.resizeObserver.observe(canvas);
    this.resize();
  }
  async connect(url,onProgress=()=>{}) {
    if(this.world||this.connecting)throw Error('Create a new adapter instance for another world; dispose the old instance first.');
    this.connecting=true;this.world=url instanceof WorldData?url:await WorldData.load(url,{onProgress});
    this.textures=createWorldTextures(this.world,this.renderer);this.material=createTerrainMaterial(this.world,this.textures);
    this.controls=new GeoCamera(this.canvas,this.world,()=>{this.planDirty=true;});
    const p=this.controls.pose(), sun=new THREE.Vector3(...p.radial).add(new THREE.Vector3(0,.35,.15)).normalize();
    this.material.uniforms.uSun.value.copy(sun);
    this.atmosphere=createAtmosphere(this.world.radius);this.atmosphere.material.uniforms.uSun.value.copy(sun);this.scene.add(this.atmosphere);
    this.controls.onPick=(x,y)=>this.pick(x,y);
    if(!this.world.fields.temperature||!this.world.fields.precipitation)this.mode='rock';
    this.setMode(this.mode);this.setQuality(this.qualityName);
    await this.initWorkers();
    this.rootPromise=new Promise((resolve,reject)=>{this.resolveRoots=resolve;this.rejectRoots=reject;});
    for(const t of roots())this.request(t);
    this.pump();await this.rootPromise;
    this.rebuildCut();this.start();
    return this;
  }
  async initWorkers(){
    const count=Math.min(2,Math.max(1,(navigator.hardwareConcurrency??2)-1));
    await Promise.all(Array.from({length:count},()=>new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./terrain.worker.js',import.meta.url),{type:'module'});const slot={worker,ready:false,busy:false,key:null};this.workers.push(slot);
      const timer=setTimeout(()=>reject(Error('Terrain worker initialization timed out.')),15000);
      worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'Terrain worker failed.'));this.onError(e.message||'Terrain worker failed.');};
      worker.onmessage=e=>{const m=e.data;
        if(m.type==='ready'){clearTimeout(timer);if(m.sourceId!==this.world.id){reject(Error('Worker source identity mismatch'));return;}slot.ready=true;resolve();this.pump();return;}
        if(!slot.ready&&m.type==='error'){clearTimeout(timer);reject(Error(m.message));return;}
        if(m.sourceId!==this.world.id){this.tileErrors++;this.onError('Ignored worker response from another source');return;}
        slot.busy=false;slot.key=null;
        const request=this.pending.get(m.id);this.pending.delete(m.id);
        if(m.type==='error'){this.tileErrors++;this.onError(m.message);if(request?.tile.level===0)this.rejectRoots?.(Error(m.message));}
        else if(m.type==='tile'&&!this.disposed){this.acceptTile(m.result);}
        this.pump();
      };
      const data=this.world.workerPayload();worker.postMessage({type:'init',...data},Object.values(data.buffers));
    })));
  }
  request(tile){const key=tileKey(tile);if(this.cache.has(key)||this.pending.has(key))return;const item={id:key,tile};this.pending.set(key,item);this.queue.push(item);}
  pump(){if(this.disposed)return;this.queue.sort((a,b)=>a.tile.level-b.tile.level);
    for(const slot of this.workers){if(!slot.ready||slot.busy)continue;const item=this.queue.shift();if(!item)break;slot.busy=true;slot.key=item.id;slot.worker.postMessage({type:'tile',id:item.id,sourceId:this.world.id,tile:item.tile,gridSize:this.gridSize});}}
  acceptTile(data){const key=tileKey(data.tile);if(this.cache.has(key))return;
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));geometry.setAttribute('positionHigh',new THREE.BufferAttribute(data.positionHigh,3));geometry.setAttribute('positionLow',new THREE.BufferAttribute(data.positionLow,3));geometry.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));geometry.setAttribute('planetPosition',new THREE.BufferAttribute(data.planetPositions,3));
    const index=new Uint16Array(this.gridSize*this.gridSize*6);index.set(indicesForMask(this.gridSize,0));geometry.setIndex(new THREE.BufferAttribute(index,1));geometry.computeBoundingSphere();
    const mesh=new THREE.Mesh(geometry,this.material);mesh.userData.tileKey=key;
    const phase=new THREE.Vector3(...data.anchor.map(v=>mod(v,2048)));
    mesh.onBeforeRender=()=>{this.material.uniforms.uPhase.value.copy(phase);this.material.uniformsNeedUpdate=true;};
    const bytes=2*(data.positions.byteLength+data.normals.byteLength+data.planetPositions.byteLength+data.positionHigh.byteLength+data.positionLow.byteLength+index.byteLength);
    this.cache.set(key,{key,tile:data.tile,data,mesh,geometry,mask:0,bytes,lastUsed:this.tick});this.generatedTiles++;this.cutDirty=true;this.evict();
    if(roots().every(t=>this.cache.has(tileKey(t))))this.resolveRoots?.();
  }
  plan(pose){const start=performance.now(),q=qualities[this.qualityName];
    const selected=selectTiles({cameraPosition:pose.position,viewDirection:pose.forward,cameraAltitude:pose.altitude,radius:this.world.radius,
      viewportHeight:this.canvas.clientHeight*this.renderer.getPixelRatio(),fovY:this.camera.fov*Math.PI/180,pixelError:q.error,maxTiles:q.tiles,maxLevel:22,gridSize:this.gridSize,
      sourceSpacing:this.world.resolutionAt(pose.radial),heightRange:this.world.heightRange,sampleHeight:this.world.sampleHeight,previousKeys:new Set(this.desired.map(tileKey))});
    this.desired=selected.tiles;this.selectionMetrics=selected.metrics;this.branches=new Set();this.needed=new Set();
    for(const tile of this.desired){this.needed.add(tileKey(tile));this.request(tile);
      for(let l=tile.level-1;l>=0;l--){const d=2**(tile.level-l),parent={face:tile.face,level:l,x:Math.floor(tile.x/d),y:Math.floor(tile.y/d)};this.branches.add(tileKey(parent));this.needed.add(tileKey(parent));this.request(parent);}}
    this.queue=this.queue.filter(j=>{if(this.needed.has(j.id))return true;this.pending.delete(j.id);return false;});
    this.cutDirty=true;this.pump();this.lastPlanPose=pose;this.plannerMs=performance.now()-start;this.planDirty=false;
  }
  rebuildCut(){if(!roots().every(t=>this.cache.has(tileKey(t))))return;
    const collect=t=>{const children=tileChildren(t);if(this.branches.has(tileKey(t))&&children.every(c=>this.cache.has(tileKey(c))))return children.flatMap(collect);return [t];};
    const cut=balanceByCoarsening(roots().flatMap(collect));const signature=cut.map(tileKey).join('|');
    if(signature===this.cutSignature){this.cutDirty=false;this.evict();return;}
    const start=performance.now(), next=new Set(cut.map(tileKey));
    for(const old of this.rendered){if(!next.has(old.key))this.rootGroup.remove(old.mesh);}
    this.rendered=cut.map(t=>{const entry=this.cache.get(tileKey(t));if(!entry)throw Error('Missing ready ancestor in rendered cut');
      const mask=edgeMask(t,cut);if(mask!==entry.mask){const indices=indicesForMask(this.gridSize,mask);entry.geometry.index.array.set(indices);entry.geometry.index.needsUpdate=true;entry.geometry.setDrawRange(0,indices.length);entry.mask=mask;}
      entry.lastUsed=this.tick;if(!entry.mesh.parent)this.rootGroup.add(entry.mesh);return entry;});
    this.renderedTiles=cut;this.cutSignature=signature;this.cutDirty=false;this.masksMs=performance.now()-start;this.evict();
  }
  evict(){const pinned=new Set(this.needed??[]);
    for(const t of this.renderedTiles??[])for(let l=t.level;l>=0;l--){const d=2**(t.level-l);pinned.add(tileKey({face:t.face,level:l,x:Math.floor(t.x/d),y:Math.floor(t.y/d)}));}
    let bytes=[...this.cache.values()].reduce((s,e)=>s+e.bytes,0);
    const old=[...this.cache.values()].filter(e=>!pinned.has(e.key)).sort((a,b)=>a.lastUsed-b.lastUsed);
    for(const e of old){if(this.cache.size<=this.maxCacheTiles&&bytes<=this.cacheBudget)break;this.rootGroup.remove(e.mesh);e.geometry.dispose();this.cache.delete(e.key);bytes-=e.bytes;}
    this.estimatedCacheBytes=bytes;
  }
  resize(){const w=Math.max(1,this.canvas.clientWidth),h=Math.max(1,this.canvas.clientHeight);this.renderer.setSize(w,h,false);this.composer.setPixelRatio(this.renderer.getPixelRatio());this.composer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  setQuality(name){if(!qualities[name])throw Error('Unknown quality');this.qualityName=name;const q=qualities[name];this.cacheBudget=q.cache*1048576;this.maxCacheTiles=Math.ceil(q.tiles*8/3)+24;this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,q.pixelRatio));this.resize();if(this.material)this.material.uniforms.uDetail.value=q.detail;this.planDirty=true;}
  setMode(mode){if(!this.textures?.[mode])return;this.mode=mode;this.material.uniforms.uMap.value=this.textures[mode];this.material.uniforms.uAnalysis.value=mode==='height'?1:0;}
  setWireframe(on){this.material.wireframe=!!on;}
  start(){if(this.running)return;this.running=true;this.lastFrame=performance.now();this.frameHandle=requestAnimationFrame(t=>this.frame(t));}
  stop(){this.running=false;cancelAnimationFrame(this.frameHandle);}
  frame(time){if(!this.running)return;const dt=(time-this.lastFrame)/1000;this.lastFrame=time;this.tick++;
    if(dt>0&&dt<.5){this.frameTimes.push(dt*1000);if(this.frameTimes.length>240)this.frameTimes.shift();}
    if(this.autoOrbit&&this.controls.altitude>75000)this.controls.longitude+=dt*.025;
    let pose=this.controls.update(dt);
    const under=this.renderedTiles?.length?getTileAtDirection(this.renderedTiles,pose.radial):null;
    const entry=under?this.cache.get(tileKey(under)):null;
    const renderGround=entry?renderedHeightAtDirection(entry.data,pose.radial,entry.mask):null;
    if(renderGround!==null&&renderGround+2>pose.ground+pose.altitude){pose=this.controls.pose(renderGround+2-pose.ground);}
    if(renderGround!==null && this.controls.targetAltitude<this.controls.altitude*.9){
      const hold=Math.abs(renderGround-pose.ground)/.01;
      if(hold>pose.altitude && Math.abs(renderGround-pose.ground)>.1){this.controls.altitude=hold;pose=this.controls.pose(hold);}
    }
    this.currentPose=pose;this.renderGround=renderGround;
    const delta=this.lastPlanPose?Math.hypot(...pose.position.map((v,i)=>v-this.lastPlanPose.position[i])):Infinity;
    const turn=this.lastPlanPose?1-pose.forward.reduce((s,v,i)=>s+v*this.lastPlanPose.forward[i],0):1;
    if((this.planDirty||delta>Math.max(.25,pose.altitude*.015)||turn>.002)&&time-this.lastPlan>160){
      // Prefetch a descent's target location before the camera reaches it.
      const prefetch=this.controls.pose(Math.min(this.controls.altitude,Math.max(this.controls.targetAltitude,this.controls.altitude*.06)));
      this.plan(prefetch);this.lastPlan=time;
    }
    if(this.cutDirty)this.rebuildCut();
    this.camera.position.set(0,0,0);this.camera.up.set(...pose.up);this.camera.lookAt(...pose.forward);
    this.camera.near=Math.max(.02,Math.min(4000,pose.altitude*.00005));this.camera.far=this.world.radius*3+pose.altitude;this.camera.updateProjectionMatrix();
    for(const e of this.rendered)e.mesh.position.set(e.data.anchor[0]-pose.position[0],e.data.anchor[1]-pose.position[1],e.data.anchor[2]-pose.position[2]);
    this.material.uniforms.uCameraHigh.value.set(...pose.position.map(Math.fround));
    this.material.uniforms.uCameraLow.value.set(...pose.position.map(v=>v-Math.fround(v)));
    this.atmosphere.position.set(...pose.position.map(v=>-v));this.material.uniforms.uAltitude.value=pose.altitude;
    const air=1-Math.min(1,pose.altitude/120000);this.scene.background.copy(this.spaceColor).lerp(this.airColor,air);
    const renderStart=performance.now();this.renderer.info.reset();this.composer.render(dt);this.renderCpuMs=performance.now()-renderStart;
    if(time-this.lastStats>300){this.onStats(this.stats());this.lastStats=time;}
    this.frameHandle=requestAnimationFrame(t=>this.frame(t));
  }
  stats(){const sorted=[...this.frameTimes].sort((a,b)=>a-b);const median=sorted[Math.floor(sorted.length*.5)]??0,p95=sorted[Math.floor(sorted.length*.95)]??0;
    return {frames:this.tick,fps:median?1000/median:0,frameMsP95:p95,renderCpuMs:this.renderCpuMs??0,plannerMs:this.plannerMs,masksMs:this.masksMs,
      renderedTiles:this.rendered.length,desiredTiles:this.desired.length,maxLevel:Math.max(0,...this.rendered.map(e=>e.tile.level)),triangles:this.renderer.info.render.triangles,drawCalls:this.renderer.info.render.calls,
      cachedTiles:this.cache.size,cacheMiB:(this.estimatedCacheBytes??0)/1048576,cacheLimitMiB:qualities[this.qualityName].cache,queue:this.pending.size,generatedTiles:this.generatedTiles,tileErrors:this.tileErrors,
      gpu:this.gpu,software:this.software,reversedDepth:!!this.renderer.capabilities.reversedDepthBuffer,logDepth:!!this.renderer.capabilities.logarithmicDepthBuffer,
      antiAliasing:'FXAA',pixelRatio:this.renderer.getPixelRatio(),sourceResolutionM:this.currentPose?this.world.resolutionAt(this.currentPose.radial):this.world?.sourceSpacing,nativeDetail:!!this.world?.nativeRegion,altitude:this.currentPose?.altitude,latitude:this.controls?.latitude,longitude:this.controls?.longitude,
      cameraClearance:this.currentPose&&this.renderGround!==null?this.currentPose.ground+this.currentPose.altitude-this.renderGround:null,
      selection:this.selectionMetrics,quality:this.qualityName,mode:this.mode};}
  pick(clientX,clientY){const rect=this.canvas.getBoundingClientRect();this.raycaster.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1),this.camera);
    const hit=this.raycaster.intersectObjects(this.rendered.map(e=>e.mesh),false)[0];if(!hit)return null;
    const point=hit.point.toArray().map((v,i)=>v+this.currentPose.position[i]);const len=Math.hypot(...point),lat=Math.asin(point[1]/len),lon=Math.atan2(point[2],point[0]);
    const sample=this.world.sample(lon,lat);this.dispatchEvent(new CustomEvent('pick',{detail:{sourceId:this.world.id,position:point,sample,representation:'native overview interpolation'}}));return sample;}
  dispose(){this.disposed=true;this.stop();this.controls?.dispose();this.resizeObserver.disconnect();for(const s of this.workers)s.worker.terminate();for(const e of this.cache.values())e.geometry.dispose();for(const t of Object.values(this.textures??{}))t.dispose();this.material?.dispose();this.atmosphere?.geometry.dispose();this.atmosphere?.material.dispose();this.fxaaPass.dispose();this.outputPass.dispose();this.renderPass.dispose();this.composer.dispose();this.renderer.dispose();this.cache.clear();}
}

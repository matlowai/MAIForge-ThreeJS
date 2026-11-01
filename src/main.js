import './style.css';
import { PlanetEngine } from './engine/PlanetEngine.js';
const $=id=>document.getElementById(id);
let engine;
const metres=n=>n>=1000?`${(n/1000).toLocaleString(undefined,{maximumFractionDigits:n>=1e5?0:1})} km`:`${n.toFixed(1)} m`;
function error(message){$('error').textContent=message;$('error').classList.remove('hidden');}
function rows(target,items){target.replaceChildren();for(const [label,value] of items){const row=document.createElement('div');row.className='metric-row';const l=document.createElement('span'),v=document.createElement('strong');l.textContent=label;v.textContent=value;row.append(l,v);target.append(row);}}
function stats(s){const n=s.altitude??0,km=n>=1000;$('app').classList.toggle('ground',n<120000);const number=km?n/1000:n;$('altitude').replaceChildren(document.createTextNode(number.toLocaleString(undefined,{maximumFractionDigits:number>=100?0:1})));const unit=document.createElement('span');unit.textContent=km?'km':'m';$('altitude').append(unit);
 $('coordinates').textContent=`${Math.abs(s.latitude*180/Math.PI).toFixed(3)}° ${s.latitude>=0?'N':'S'}  /  ${Math.abs(s.longitude*180/Math.PI).toFixed(3)}° ${s.longitude>=0?'E':'W'}`;
 $('fps').textContent=Math.round(s.fps);$('meshStats').textContent=`${s.renderedTiles} tiles · L${s.maxLevel}`;
 $('status').replaceChildren();const dot=document.createElement('i');$('status').append(dot,document.createTextNode(s.queue?`Refining · ${s.queue} queued`:'Native source verified'));
 $('navigationHint').textContent=n>75000?'Drag to orbit · scroll to descend':'Drag to look · WASD move · Q / E altitude';
 $('scaleLabel').textContent=`${s.nativeDetail?'Native terrain':'Native overview'} ${metres(s.sourceResolutionM)} · mesh LOD ${s.maxLevel}`;
 rows($('performancePanel'),[['Frame p95',`${s.frameMsP95.toFixed(1)} ms`],['Render submission',`${s.renderCpuMs.toFixed(1)} ms`],['Draw calls',String(s.drawCalls)],['Triangles',s.triangles.toLocaleString()],['Cached tiles',String(s.cachedTiles)],['Est. tile memory',`${s.cacheMiB.toFixed(1)} MiB`],['Pending jobs',String(s.queue)],['Render clearance',s.cameraClearance===null?'—':metres(s.cameraClearance)],['Depth',s.reversedDepth?'Reversed':s.logDepth?'Logarithmic':'Standard'],['Anti-aliasing',s.antiAliasing],['Pixel ratio',s.pixelRatio.toFixed(1)]]);
 const gpu=document.createElement('div');gpu.className='gpu';gpu.textContent=s.gpu;$('performancePanel').append(gpu);
}
for(const button of document.querySelectorAll('[data-preset]'))button.addEventListener('click',()=>{if(!engine?.controls)return;engine.controls.preset(button.dataset.preset);document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('active',b===button));});
for(const button of document.querySelectorAll('[data-mode]'))button.addEventListener('click',()=>{if(!engine?.world)return;engine.setMode(button.dataset.mode);document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b===button));});
$('quality').addEventListener('change',e=>engine?.setQuality(e.target.value));$('wireframe').addEventListener('change',e=>engine?.setWireframe(e.target.checked));$('autoOrbit').addEventListener('change',e=>{if(engine)engine.autoOrbit=e.target.checked;});
$('zoomIn').addEventListener('click',()=>{if(engine?.controls){engine.controls.targetAltitude=Math.max(2,engine.controls.targetAltitude/2);engine.planDirty=true;}});
$('zoomOut').addEventListener('click',()=>{if(engine?.controls){engine.controls.targetAltitude=Math.min(engine.world.radius*5,engine.controls.targetAltitude*2);engine.planDirty=true;}});
$('performanceButton').addEventListener('click',()=>{const closed=$('performancePanel').classList.toggle('hidden');$('performanceButton').setAttribute('aria-expanded',String(!closed));});
$('helpButton').addEventListener('click',()=>$('help').showModal());$('closeHelp').addEventListener('click',()=>$('help').close());$('closeInspector').addEventListener('click',()=>{$('inspector').classList.add('hidden');$('app').classList.remove('has-inspector');});
window.addEventListener('keydown',e=>{if(e.code==='KeyH'&&!/INPUT|TEXTAREA/.test(e.target.tagName)){e.preventDefault();$('help').open?$('help').close():$('help').showModal();}});
try{
 engine=new PlanetEngine($('viewport'),{onStats:stats,onError:error});
 const requested=new URLSearchParams(location.search).get('world');const url=requested?new URL(requested,location.href).href:new URL('data/reference/manifest.json',document.baseURI).href;
 await engine.connect(url,p=>{$('progress').style.width=`${Math.round(p*100)}%`;$('loadLabel').textContent=p<1?'Verifying native fields':'Building first visible tiles';});
 $('loading').classList.add('hidden');$('quality').value=engine.qualityName;
 if(!engine.world.fields.temperature||!engine.world.fields.precipitation){document.querySelector('[data-mode="climate"]').disabled=true;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode==='rock'));}
 const m=engine.world.manifest;$('sourceSummary').textContent=`Seed ${m.seed} · ${m.epochMy} million model years · ${m.grid.cols} × ${m.grid.rows} native cells. This reference has ${metres(m.sourceResolutionM)} source spacing. Subdividing its mesh does not add finer geological history. ${engine.world.nativeRegion?`A bounded native terrain region has ${metres(engine.world.nativeRegion.resolutionM)} process spacing. Outside it, a sparse native-model render proxy provides context; its global height error is unknown. Edge blending is a display approximation, not simulation or collision authority.`:`This overview pack does not contain fine terrain.`}`;
 $('sourceBadge').textContent=`SEED ${m.seed}  /  ${m.epochMy} MY  /  VERIFIED NATIVE DATA`;
 engine.addEventListener('pick',e=>{const s=e.detail.sample;const rock=engine.world.manifest.lithologyCodes?.[s.lithology]??'unknown';rows($('sampleFields'),[['Position',`${s.latitude.toFixed(3)}°, ${s.longitude.toFixed(3)}°`],['Overview ground',metres(s.elevation)],['Rendered surface',metres(s.renderSurfaceHeight)],...(s.nativeHeight!==null?[['Native solid height',metres(s.nativeHeight)],['Detail weight',`${Math.round(s.nativeWeight*100)}%`]]:[]),['Material',rock.replaceAll('_',' ')],['Water',['Dry','Marine','Lake'][s.waterKind]??'Unknown'],...(s.temperature!==undefined?[['Mean temperature',`${s.temperature.toFixed(1)} °C`]]:[]),...(s.precipitation!==undefined?[['Precipitation',`${Math.round(s.precipitation)} mm/yr`]]:[])]);$('inspector').classList.remove('hidden');$('app').classList.add('has-inspector');});
 if(new URLSearchParams(location.search).has('qa'))window.__MAIFORGE_TEST__={engine,stats:()=>engine.stats(),resetFrames:()=>{engine.frameTimes=[];},preset:name=>engine.controls.preset(name),setAltitude:h=>{engine.controls.targetAltitude=h;engine.controls.altitude=h;engine.planDirty=true;},setPosition:(lat,lon)=>{engine.controls.latitude=lat*Math.PI/180;engine.controls.longitude=lon*Math.PI/180;engine.planDirty=true;},sourceId:engine.world.id};
}catch(e){$('loading').classList.add('hidden');error(e.message);console.error(e);}
window.addEventListener('pagehide',()=>engine?.dispose(),{once:true});

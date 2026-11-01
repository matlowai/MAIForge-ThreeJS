const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
export const direction=(lat,lon)=>[Math.cos(lat)*Math.cos(lon),Math.sin(lat),Math.cos(lat)*Math.sin(lon)];
export class GeoCamera {
  constructor(canvas,world,onInteract=()=>{}) {
    this.canvas=canvas;this.world=world;const start=world.suggestedView();
    this.latitude=start.latitude;this.longitude=start.longitude;this.heading=start.heading??0;this.pitchOffset=0;
    this.altitude=world.radius*1.5;this.targetAltitude=this.altitude;this.keys=new Set();this.drag=null;this.onInteract=onInteract;
    this.abort=new AbortController();const opt={signal:this.abort.signal};
    canvas.addEventListener('pointerdown',e=>{canvas.focus();canvas.setPointerCapture(e.pointerId);this.drag={x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,button:e.button};},opt);
    canvas.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;this.drag.x=e.clientX;this.drag.y=e.clientY;
      if(this.drag.button===2){const scale=Math.max(1,this.altitude)*1.15/canvas.clientHeight;this.move(-dx*scale,dy*scale);}
      else if(this.altitude>75000){this.longitude-=dx*.004;this.latitude=clamp(this.latitude+dy*.003,-Math.PI/2+1e-6,Math.PI/2-1e-6);}
      else{this.heading-=dx*.004;this.pitchOffset=clamp(this.pitchOffset+dy*.003,-1.3,1.3);}this.onInteract();},opt);
    canvas.addEventListener('pointerup',e=>{const d=this.drag;this.drag=null;if(d&&Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<4)this.onPick?.(e.clientX,e.clientY);},opt);
    canvas.addEventListener('pointercancel',()=>{this.drag=null;},opt);
    canvas.addEventListener('contextmenu',e=>e.preventDefault(),opt);
    canvas.addEventListener('wheel',e=>{e.preventDefault();this.targetAltitude=clamp(this.targetAltitude*Math.exp(clamp(e.deltaY,-200,200)*.0025),2,world.radius*5);this.onInteract();},{...opt,passive:false});
    window.addEventListener('keydown',e=>{if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;if(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE','ShiftLeft','ShiftRight'].includes(e.code)){this.keys.add(e.code);e.preventDefault();}},opt);
    window.addEventListener('keyup',e=>this.keys.delete(e.code),opt);
    window.addEventListener('blur',()=>this.keys.clear(),opt);
  }
  move(east,north){const d=direction(this.latitude,this.longitude),e=[-Math.sin(this.longitude),0,Math.cos(this.longitude)],n=[-Math.sin(this.latitude)*Math.cos(this.longitude),Math.cos(this.latitude),-Math.sin(this.latitude)*Math.sin(this.longitude)];
    const q=norm(d.map((v,i)=>v+(e[i]*east+n[i]*north)/this.world.radius));this.latitude=Math.asin(clamp(q[1],-1,1));this.longitude=Math.atan2(q[2],q[0]);}
  preset(name){this.targetAltitude=name==='planet'?this.world.radius*1.5:name==='region'?1000000:3;this.pitchOffset=0;this.onInteract();}
  update(dt){dt=Math.min(dt,.06);this.longitude=((this.longitude+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;this.heading=((this.heading+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;this.altitude=Math.exp(Math.log(this.altitude)+(Math.log(this.targetAltitude)-Math.log(this.altitude))*(1-Math.exp(-dt*3)));
    const boost=this.keys.has('ShiftLeft')||this.keys.has('ShiftRight')?4:1,speed=Math.max(4,this.altitude*.55)*boost;
    const f=(this.keys.has('KeyW')?1:0)-(this.keys.has('KeyS')?1:0),s=(this.keys.has('KeyD')?1:0)-(this.keys.has('KeyA')?1:0);
    if(f||s)this.move((Math.sin(this.heading)*f+Math.cos(this.heading)*s)*speed*dt,(Math.cos(this.heading)*f-Math.sin(this.heading)*s)*speed*dt);
    if(this.keys.has('KeyE'))this.targetAltitude=clamp(this.targetAltitude+speed*dt,2,this.world.radius*5);
    if(this.keys.has('KeyQ'))this.targetAltitude=clamp(this.targetAltitude-speed*dt,2,this.world.radius*5);
    return this.pose(this.altitude);}
  pose(altitude=this.altitude){const radial=direction(this.latitude,this.longitude),north=[-Math.sin(this.latitude)*Math.cos(this.longitude),Math.cos(this.latitude),-Math.sin(this.latitude)*Math.sin(this.longitude)],east=[-Math.sin(this.longitude),0,Math.cos(this.longitude)];
    const weight=clamp((Math.log10(Math.max(altitude,1))-3)/3,0,1);const base=-.12+(-Math.PI/2+.12)*weight;
    const pitch=clamp(base+this.pitchOffset,-Math.PI/2+.001,Math.PI/2-.05);
    const forward=norm(radial.map((v,i)=>Math.cos(pitch)*(north[i]*Math.cos(this.heading)+east[i]*Math.sin(this.heading))+v*Math.sin(pitch)));
    const ground=this.world.sampleHeight(radial);const position=radial.map(v=>v*(this.world.radius+ground+altitude));
    return {position,forward,up:Math.abs(Math.sin(pitch))>.98?north:radial,radial,ground,altitude,latitude:this.latitude,longitude:this.longitude};}
  dispose(){this.abort.abort();}
}

import * as THREE from 'three';
const clamp = (x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,t)=>a.map((v,i)=>v*(1-t)+b[i]*t);
// Global visualization priors keyed by native lithology, not place-specific art.
const rocks=[[116,119,116],[155,145,133],[122,126,126],[81,91,96],[181,174,149],[126,119,108],[174,139,100],[148,131,110],[209,199,176],[76,73,66],[157,142,111],[62,77,88]];
export function createWorldTextures(world, renderer) {
  const {rows,cols,fields}=world;
  const modes={rock:new Uint8Array(cols*(rows+2)*4),climate:new Uint8Array(cols*(rows+2)*4),height:new Uint8Array(cols*(rows+2)*4)};
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++) {
    const i=y*cols+x,k=((y+1)*cols+x)*4, wet=fields.waterKind[i]>0;
    const elevation=fields.elevation[i], depth=Math.max(0,fields.surfaceHeight[i]-elevation);
    let rock=rocks[fields.lithology[i]]??[143,145,139], climate=rock;
    if(world.fields.temperature && world.fields.precipitation && !wet) {
      const t=fields.temperature[i], p=fields.precipitation[i];
      const green=clamp((p-150)/1700)*clamp((t+2)/18)*.72;
      climate=mix(rock,[57,86,56],green);
      const snow=clamp((1-t)/10)*clamp(p/220)*.93;
      climate=mix(climate,[221,232,230],snow);
    }
    const transmission=Math.exp(-depth/75);
    const ocean=mix([9,37,58],mix(rock,[30,94,108],.2),transmission);
    if(wet){rock=ocean;climate=ocean;}
    const h=clamp((elevation+7000)/12000);
    let hypsometry=h<.58?mix([9,31,65],[62,140,145],h/.58):mix([103,136,100],[241,224,190],(h-.58)/.42);
    for(const [name,color] of Object.entries({rock,climate,height:hypsometry})) {
      modes[name].set([...color.map(v=>Math.round(clamp(v,0,255))),wet?255:0],k);
    }
  }
  // Constant pole rows; CPU and GPU both converge to a longitude-independent pole.
  for(const data of Object.values(modes))for(const [source,target] of [[1,0],[rows,rows+1]]) {
    const avg=[0,0,0,0];for(let x=0;x<cols;x++)for(let c=0;c<4;c++)avg[c]+=data[(source*cols+x)*4+c]/cols;
    for(let x=0;x<cols;x++)data.set(avg.map(Math.round),(target*cols+x)*4);
  }
  return Object.fromEntries(Object.entries(modes).map(([name,data])=>{
    const texture=new THREE.DataTexture(data,cols,rows+2,THREE.RGBAFormat,THREE.UnsignedByteType);
    texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;
    texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;
    texture.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());texture.needsUpdate=true;
    return [name,texture];
  }));
}

export function createTerrainMaterial(world,textures) {
  return new THREE.ShaderMaterial({
    uniforms:{uMap:{value:textures.climate},uRows:{value:world.rows},uPhase:{value:new THREE.Vector3()},uCameraHigh:{value:new THREE.Vector3()},uCameraLow:{value:new THREE.Vector3()},
      uSun:{value:new THREE.Vector3(1,.5,.5).normalize()},uAltitude:{value:1e6},uDetail:{value:1},uAnalysis:{value:0}},
    vertexShader:`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 planetPosition,positionHigh,positionLow;
      uniform vec3 uPhase,uCameraHigh,uCameraLow;
      varying vec3 vPlanet; varying vec3 vNormal; varying vec3 vView; varying vec3 vMaterial;
      void main(){
        vec4 p=vec4((positionHigh-uCameraHigh)+(positionLow-uCameraLow),1.);
        vPlanet=planetPosition; vNormal=normal;vView=-p.xyz;vMaterial=position+uPhase;
        gl_Position=projectionMatrix*viewMatrix*p;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader:`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D uMap;uniform float uRows;uniform vec3 uSun;uniform float uAltitude,uDetail,uAnalysis;
      varying vec3 vPlanet,vNormal,vView,vMaterial;
      float hash3(vec3 p){p=mod(p,128.);p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.x+p.y)*p.z);}
      float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x),mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x),mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x),f.y),f.z);}
      float band(vec3 p,float f,float pixelFootprint){float footprint=pixelFootprint*f;
        return (noise3(p*f)-.5)*(1.-smoothstep(.15,.8,footprint));}
      vec3 bump(vec3 n,float h){vec3 px=dFdx(-vView),py=dFdy(-vView);vec3 r1=cross(py,n),r2=cross(n,px);
        float det=dot(px,r1);return normalize(abs(det)*n-sign(det)*(dFdx(h)*r1+dFdy(h)*r2));}
      void main(){
        #include <logdepthbuf_fragment>
        vec3 dir=normalize(vPlanet); float lon=atan(dir.z,dir.x),lat=asin(clamp(dir.y,-1.,1.));
        float row=(lat/PI+.5)*uRows;float ty=row+1.;
        if(row<.5)ty=.5+2.*row;else if(row>uRows-.5)ty=uRows+.5+2.*(row-uRows+.5);
        vec2 uv=vec2(lon/(2.*PI)+.5,ty/(uRows+2.));vec4 mapped=texture2D(uMap,uv);
        float wet=smoothstep(.25,.75,mapped.a),distanceM=length(vView);
        vec3 n=normalize(vNormal),view=normalize(vView),albedo=mapped.rgb;
        float detail=uDetail*(1.-uAnalysis)*(1.-wet)*(1.-smoothstep(1500.,15000.,distanceM));
        if(uDetail>.5 && uAnalysis<.5){
          float footprint=max(max(fwidth(vMaterial.x),fwidth(vMaterial.y)),fwidth(vMaterial.z));
          float grain=0.;
          if(detail>.001)grain=band(vMaterial,4.,footprint)*.35+band(vMaterial,1.,footprint)*.35+band(vMaterial,.25,footprint)*.2+band(vMaterial,.0625,footprint)*.1;
          albedo*=1.+grain*.45*detail;
          n=bump(n,grain*.025*detail);
        }
        float ndl=max(dot(n,uSun),0.);float ambient=.19+.06*max(dot(n,dir),0.);
        vec3 halfV=normalize(uSun+view);float spec=pow(max(dot(n,halfV),0.),mix(18.,120.,wet))*mix(.035,.7,wet);
        vec3 color=albedo*(ambient+ndl*1.15)+vec3(1.,.94,.83)*spec*ndl;
        float day=clamp(dot(dir,uSun)*.5+.5,0.,1.);
        float fog=(1.-exp(-distanceM/70000.))*exp(-max(uAltitude,0.)/90000.);
        vec3 air=mix(vec3(.022,.038,.065),vec3(.36,.49,.57),day);
        color=mix(color,air,fog*.82);
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export function createAtmosphere(radius) {
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.BackSide,
    uniforms:{uSun:{value:new THREE.Vector3(1,.5,.5).normalize()}},
    vertexShader:`#include <common>\n#include <logdepthbuf_pars_vertex>\nvarying vec3 vN,vP;void main(){vN=normal;vec4 p=modelMatrix*vec4(position,1.);vP=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;\n#include <logdepthbuf_vertex>\n}`,
    fragmentShader:`#include <common>\n#include <logdepthbuf_pars_fragment>\nvarying vec3 vN,vP;uniform vec3 uSun;void main(){\n#include <logdepthbuf_fragment>\nvec3 n=normalize(vN);float rim=pow(1.-abs(dot(n,normalize(-vP))),3.);float sun=.15+.85*max(dot(n,uSun),0.);gl_FragColor=vec4(vec3(.24,.49,.73)*sun,rim*.38);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}`});
  return new THREE.Mesh(new THREE.SphereGeometry(radius*1.016,64,48),material);
}

import { GRID_SIZE as N, project, createTerrain, heightAt, triangles, contourSegments, editTerrain } from './geometry.js';
import { createSoftwareRenderer } from './software-renderer.js';

const $ = id => document.getElementById(id);
const canvas = $('terrain'), overlay = $('overlay'), box = $('viewport');
const ink = overlay.getContext('2d');
const storageKey = 'terrain-atelier-prototype-v1';
const titles = { valley: '河谷与双丘', island: '水岸与岛丘', plateau: '台地与缓坡' };
let heights = createTerrain(), preset = 'valley', tool = 'inspect';
let radius = 2, strength = .18, target = 1.5, interval = 1;
let showGrid = true, showContours = true, showWater = true;
let zoom = 1, ox = 0, oy = 0, width = 1, height = 1, dpr = 1;
let selection = null, hover = null, mesh = [], skirtMesh = [], contourLabels = [], projected = [], projectedSkirts = [];
let history = [], pointers = new Map(), gesture = null, painting = false, space = false, panMode = false;
let lastPaint = 0, dirty = true, pending = false, firstSize = true, lastFrame = 0;
let saveTimer, toastTimer;
let touchPaintTimer;

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved?.version === 1 && saved.heights?.length === (N + 1) ** 2 && saved.heights.every(h => Number.isFinite(h) && h >= -1.5 && h <= 8)) {
    heights = Float64Array.from(saved.heights);
    preset = titles[saved.preset] ? saved.preset : 'valley';
  }
} catch {}

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 2200);
}
function persistNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, preset, heights: Array.from(heights, h => +h.toFixed(5)) })); }
  catch { toast('当前修改保留在本次页面中，浏览器未允许本地保存'); }
}
function save() {clearTimeout(saveTimer);saveTimer=setTimeout(persistNow,250);}
function remember() {
  history.push({ heights: heights.slice(), preset });
  if (history.length > 24) history.shift();
  $('undo').disabled = false;
}
function updatePresets() {
  document.querySelectorAll('[data-preset]').forEach(b => {
    const active = b.dataset.preset === preset;
    b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active));
  });
  $('terrain-name').textContent = titles[preset];
}
function undo() {
  const previous = history.pop(); if (!previous) return;
  heights = previous.heights; preset = previous.preset;
  $('undo').disabled = !history.length;
  dirty = true; updatePresets(); refreshSelection(); requestDraw(); save(); toast('已撤销上一步');
}

// The same world coordinates drive terrain faces, contours, picking and brush editing.
let gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
let ctx2d = null, program, locations, buffers = {}, softwareBatches = {};
const softwareRenderer = createSoftwareRenderer();
if (!gl) ctx2d = canvas.getContext('2d');
function shader(type, source) {
  const result = gl.createShader(type); gl.shaderSource(result, source); gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
  return result;
}
if (gl) {
  program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec4 a_color;
    uniform vec2 u_size, u_origin;
    uniform float u_zoom, u_bias;
    varying vec4 v_color;
    varying float v_height;
    void main() {
      vec2 p=vec2(26.0*(a_position.x-a_position.y),13.0*(a_position.x+a_position.y)-26.0*a_position.z)*u_zoom+u_origin;
      gl_Position=vec4(p.x/u_size.x*2.0-1.0,1.0-p.y/u_size.y*2.0,-(a_position.x+a_position.y+a_position.z)/100.0+u_bias,1.0);
      v_color=a_color; v_height=a_position.z;
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `
    precision mediump float;
    varying vec4 v_color;
    varying float v_height;
    uniform float u_bands, u_interval;
    void main(){
      float band=u_bands>0.5 ? 1.0-0.045*fract(v_height/u_interval) : 1.0;
      gl_FragColor=vec4(v_color.rgb*band,v_color.a);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  locations = Object.fromEntries(['size', 'origin', 'zoom', 'bias', 'bands', 'interval'].map(k => [k, gl.getUniformLocation(program, 'u_' + k)]));
  locations.position = gl.getAttribLocation(program, 'a_position');
  locations.color = gl.getAttribLocation(program, 'a_color');
  gl.useProgram(program); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.enableVertexAttribArray(locations.position); gl.enableVertexAttribArray(locations.color);
}
const mix = (a,b,t) => a.map((v,i) => v + (b[i]-v)*t);
const vertex = (array,p,color) => array.push(p.u,p.v,p.h,...color);
function landColor(h, shade = 1) {
  const low = [.40,.61,.43], mid = [.67,.74,.48], high = [.84,.81,.66];
  const t = Math.max(0, Math.min(1, h / 6));
  const c = t < .55 ? mix(low, mid, t/.55) : mix(mid, high, (t-.55)/.45);
  return [...c.map(v => v*shade),1];
}
function shadeFor(t) {
  const [a,b,c] = t;
  const ax=b.u-a.u, ay=b.v-a.v, az=b.h-a.h, bx=c.u-a.u, by=c.v-a.v, bz=c.h-a.h;
  let nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
  if (nz<0) {nx=-nx;ny=-ny;nz=-nz;}
  const len=Math.hypot(nx,ny,nz)||1;
  return .85+.19*(-.42*nx-.50*ny+.75*nz)/len;
}
function upload(name, array) {
  buffers[name] ||= { handle: gl.createBuffer(), count: 0 };
  const b=buffers[name]; b.count=array.length/7;
  gl.bindBuffer(gl.ARRAY_BUFFER,b.handle); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(array),gl.DYNAMIC_DRAW);
}
function drawBuffer(name, mode, bias=0, bands=false) {
  const b=buffers[name]; if (!b?.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER,b.handle);
  gl.vertexAttribPointer(locations.position,3,gl.FLOAT,false,28,0);
  gl.vertexAttribPointer(locations.color,4,gl.FLOAT,false,28,12);
  gl.uniform1f(locations.bias,bias); gl.uniform1f(locations.bands,bands?1:0);
  gl.drawArrays(mode,0,b.count);
}
function rebuild() {
  mesh=triangles(heights);
  const surface=[], skirt=[], grid=[], contours=[], water=[];
  skirtMesh=[];
  const contourKeys=new Set();
  contourLabels=[];
  const low=Math.min(...heights), high=Math.max(...heights);
  $('legend-range').textContent=`${Math.floor(low)} — ${Math.ceil(high)} m`;
  for (const t of mesh) {
    const shade=shadeFor(t);
    t.forEach(p=>vertex(surface,p,landColor(p.h,shade)));
    const start=Math.ceil(Math.min(...t.map(p=>p.h))/interval)*interval;
    const end=Math.max(...t.map(p=>p.h));
    for(let level=start;level<=end+1e-7;level+=interval) {
      for(const segment of contourSegments(t,level)) {
        const key=segment.map(p=>`${p.u.toFixed(7)},${p.v.toFixed(7)},${level.toFixed(4)}`).sort().join('|');
        if(contourKeys.has(key))continue;contourKeys.add(key);
        segment.forEach(p=>vertex(contours,p,[.20,.34,.23,.76]));
        contourLabels.push({level, segment});
      }
    }
  }
  for(let j=0;j<=N;j++) for(let i=0;i<N;i++) {
    const a={u:i,v:j,h:heights[j*(N+1)+i]}, b={u:i+1,v:j,h:heights[j*(N+1)+i+1]};
    [a,b].forEach(p=>vertex(grid,p,[.21,.34,.23,.24]));
    const c={u:j,v:i,h:heights[i*(N+1)+j]}, d={u:j,v:i+1,h:heights[(i+1)*(N+1)+j]};
    [c,d].forEach(p=>vertex(grid,p,[.21,.34,.23,.24]));
  }
  const borders=[Array.from({length:N+1},(_,i)=>({u:i,v:0})),Array.from({length:N+1},(_,i)=>({u:N,v:i})),Array.from({length:N+1},(_,i)=>({u:N-i,v:N})),Array.from({length:N+1},(_,i)=>({u:0,v:N-i}))];
  for(let edge=0;edge<4;edge++) for(let i=0;i<N;i++) {
    const a={...borders[edge][i]}, b={...borders[edge][i+1]};
    a.h=heightAt(heights,a.u,a.v); b.h=heightAt(heights,b.u,b.v);
    const c={...a,h:-2},d={...b,h:-2};
    skirtMesh.push([a,b,c],[c,b,d]);
    const color=edge===1?[.37,.40,.29,1]:edge===2?[.45,.47,.34,1]:[.43,.46,.32,1];
    [a,b,c,c,b,d].forEach(p=>vertex(skirt,p,color));
  }
  [{u:0,v:0,h:.35},{u:N,v:0,h:.35},{u:N,v:N,h:.35},{u:0,v:0,h:.35},{u:N,v:N,h:.35},{u:0,v:N,h:.35}].forEach(p=>vertex(water,p,[.48,.66,.68,.86]));
  if(gl){upload('surface',surface);upload('skirt',skirt);upload('grid',grid);upload('contours',contours);upload('water',water);}
  else softwareBatches={surface,skirt,grid,contours,water};
  dirty=false;
}
function pt(p) { const v=project(p.u,p.v,p.h,zoom,ox,oy); return {x:v.x,y:v.y}; }
function updateProjected() {
  projected=mesh.map(t=>({ t, screen:t.map(pt) }));
  projectedSkirts=skirtMesh.map(t=>({t,screen:t.map(pt)}));
}
function barycentric(x,y,p) {
  const [a,b,c]=p, den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
  if(Math.abs(den)<1e-8) return null;
  const w0=((b.y-c.y)*(x-c.x)+(c.x-b.x)*(y-c.y))/den;
  const w1=((c.y-a.y)*(x-c.x)+(a.x-c.x)*(y-c.y))/den, w2=1-w0-w1;
  return w0>=-1e-7&&w1>=-1e-7&&w2>=-1e-7?[w0,w1,w2]:null;
}
function hit(x,y) {
  let result=null, depth=-Infinity;
  for(const {t,screen} of projected) {
    const weights=barycentric(x,y,screen); if(!weights)continue;
    const p={u:0,v:0,h:0};
    weights.forEach((w,i)=>{p.u+=t[i].u*w;p.v+=t[i].v*w;p.h+=t[i].h*w;});
    const d=p.u+p.v+p.h;
    if(d>depth){depth=d;result=p;}
  }
  for(const {t,screen} of projectedSkirts) {
    const weights=barycentric(x,y,screen);if(!weights)continue;
    const d=t.reduce((s,p,i)=>s+(p.u+p.v+p.h)*weights[i],0);
    if(d>depth+1e-6){depth=d;result=null;}
  }
  // A submerged grid cell remains selectable through the flat water surface.
  if(showWater) {
    const sx=(x-ox)/zoom/26, sy=((y-oy)/zoom+26*.35)/13;
    const u=(sx+sy)/2,v=(sy-sx)/2;
    if(u>=0&&v>=0&&u<=N&&v<=N) {
      const h=heightAt(heights,u,v), d=u+v+.35;
      if(h<.35&&d>depth)result={u,v,h};
    }
  }
  return result;
}
function lineOnTerrain(points,color,lineWidth=1,close=false) {
  ink.beginPath();points.forEach((p,i)=>{const a=pt(p);if(i===0)ink.moveTo(a.x,a.y);else ink.lineTo(a.x,a.y);});
  if(close)ink.closePath();ink.strokeStyle=color;ink.lineWidth=lineWidth;ink.stroke();
}
function cellOutline(u,v) {
  const points=[];
  for(const [a,b] of [[{u,v},{u:u+1,v}],[{u:u+1,v},{u:u+1,v:v+1}],[{u:u+1,v:v+1},{u,v:v+1}],[{u,v:v+1},{u,v}]]) {
    for(let k=0;k<4;k++){const u=a.u+(b.u-a.u)*k/4,v=a.v+(b.v-a.v)*k/4;points.push({u,v,h:Math.max(showWater?.35:-2,heightAt(heights,u,v))+.012});}
  }
  return points;
}
function drawOverlay() {
  ink.setTransform(dpr,0,0,dpr,0,0);ink.clearRect(0,0,width,height);
  if(showContours) {
    const placed=[];
    for(let level=Math.ceil(Math.max(showWater?.35:-Infinity,Math.min(...heights))/interval)*interval;level<=Math.max(...heights);level+=interval) {
      const candidates=contourLabels.filter(c=>Math.abs(c.level-level)<.001);
      let candidate=null,score=-Infinity;
      for(const c of candidates) {
        const a=pt(c.segment[0]),b=pt(c.segment[1]);
        const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
        if(x<60||x>width-75||y<45||y>height-120||placed.some(p=>Math.hypot(p.x-x,p.y-y)<55))continue;
        const visible=hit(x,y);
        if(!visible||Math.abs(visible.h-level)>.06)continue;
        const s=x-y*.12;
        if(s>score){score=s;candidate={x,y};}
      }
      if(candidate) {
        placed.push(candidate);const label=`${+level.toFixed(1)} m`;
        ink.font='11px "Segoe UI", "Microsoft YaHei", sans-serif';
        const w=ink.measureText(label).width+10;
        ink.fillStyle='#e8eededd';ink.fillRect(candidate.x-w/2,candidate.y-8,w,16);
        ink.fillStyle='#354f36';ink.textAlign='center';ink.textBaseline='middle';ink.fillText(label,candidate.x,candidate.y);
      }
    }
  }
  if(selection) {
    lineOnTerrain(cellOutline(selection.u,selection.v),'#e5f4b3',6* Math.min(zoom,1));
    lineOnTerrain(cellOutline(selection.u,selection.v),'#315d43',1.5);
  }
  if(hover&&tool!=='inspect'&&!panMode&&!space) {
    const points=[];
    for(let i=0;i<=72;i++) {
      const a=i/72*Math.PI*2,u=hover.u+Math.cos(a)*radius,v=hover.v+Math.sin(a)*radius;
      if(u<0||v<0||u>N||v>N){points.push(null);continue;}
      points.push({u,v,h:Math.max(showWater?.35:-2,heightAt(heights,u,v))+.016});
    }
    ink.setLineDash([4,3]);
    let group=[]; for(const p of points){if(p)group.push(p);else if(group.length){lineOnTerrain(group,'#eff8df',2);group=[];}}
    if(group.length)lineOnTerrain(group,'#eff8df',2);
    ink.setLineDash([]);
    const center=pt({...hover,h:Math.max(showWater?.35:-2,hover.h)});
    ink.beginPath();ink.arc(center.x,center.y,3,0,Math.PI*2);ink.fillStyle='#f3f8e9';ink.fill();
  }
}
function drawFallback() {
  softwareRenderer.render(ctx2d,width,height,dpr,{batches:softwareBatches,view:{zoom,ox,oy},showWater,showGrid,showContours,interval});
}
function draw() {
  pending=false;
  if(dirty)rebuild();updateProjected();
  if(gl) {
    gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);gl.uniform2f(locations.size,width,height);gl.uniform2f(locations.origin,ox,oy);
    gl.uniform1f(locations.zoom,zoom);gl.uniform1f(locations.interval,interval);
    drawBuffer('skirt',gl.TRIANGLES);drawBuffer('surface',gl.TRIANGLES,0,showContours);
    if(showWater)drawBuffer('water',gl.TRIANGLES);
    if(showGrid)drawBuffer('grid',gl.LINES,-.00004);
    if(showContours)drawBuffer('contours',gl.LINES,-.00008);
  } else drawFallback();
  drawOverlay();
  $('zoom-value').textContent=Math.round(zoom*100)+'%';
  $('footer-scale').textContent=`${(52*zoom).toFixed(0)} × ${(26*zoom).toFixed(0)} px / 格 @ ${Math.round(zoom*100)}%`;
}
function requestDraw() { if(!pending){pending=true;requestAnimationFrame(draw);} }
function fit() {
  const points=triangles(heights).flat().map(p=>project(p.u,p.v,p.h));
  points.push(project(N,N,-2),project(0,N,-2),project(N,0,-2));
  const minx=Math.min(...points.map(p=>p.x)),maxx=Math.max(...points.map(p=>p.x));
  const miny=Math.min(...points.map(p=>p.y)),maxy=Math.max(...points.map(p=>p.y));
  const side=width<500?24:64,top=25,bottom=125;
  zoom=Math.max(.12,Math.min(1.15,(width-2*side)/(maxx-minx),(height-top-bottom)/(maxy-miny)));
  ox=width/2-(minx+maxx)/2*zoom;oy=top+(height-top-bottom)/2-(miny+maxy)/2*zoom;
  requestDraw();
}
function resize() {
  const oldW=width,oldH=height;
  width=box.clientWidth;height=box.clientHeight;dpr=Math.min(devicePixelRatio||1,2);
  for(const c of [canvas,overlay]){c.width=Math.round(width*dpr);c.height=Math.round(height*dpr);}
  if(firstSize){firstSize=false;fit();}else if(!gesture){ox+=(width-oldW)/2;oy+=(height-oldH)/2; if(width<620)fit();}
  setTool(tool);
  requestDraw();
}
function scaleAt(value,x=width/2,y=height/2) {
  const z=Math.max(.12,Math.min(2.5,value));
  ox=x-(x-ox)*z/zoom;oy=y-(y-oy)*z/zoom;zoom=z;requestDraw();
}
function refreshSelection() {
  if(!selection)return;
  const {u,v}=selection,h=heightAt(heights,u+.5,v+.5);
  const dx=(heightAt(heights,u+1,v+.5)-heightAt(heights,u,v+.5)),dy=heightAt(heights,u+.5,v+1)-heightAt(heights,u+.5,v);
  const slope=Math.atan(Math.hypot(dx,dy))*180/Math.PI;
  $('selection').lastElementChild.textContent=`格 (${u+1}, ${v+1})  ·  标高 ${h.toFixed(2)} m  ·  坡度 ${slope.toFixed(1)}°${showWater&&h<.35?'  ·  水下地块':''}`;
}
function select(p) {
  if(!p)return;selection={u:Math.min(N-1,Math.max(0,Math.floor(p.u))),v:Math.min(N-1,Math.max(0,Math.floor(p.v)))};
  refreshSelection();requestDraw();
}
function setTool(value) {
  tool=value;
  document.querySelectorAll('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('brush-options').hidden=tool==='inspect';$('flatten-option').hidden=tool!=='flatten';
  $('strength-value').textContent=tool==='smooth'||tool==='flatten'?Math.round(strength*100)+'%':strength.toFixed(2)+' m';
  $('scene-hint').textContent=matchMedia('(pointer: coarse)').matches?'拖动雕刻 · 双指缩放或平移 · ✥ 拖动视图':tool==='inspect'?'点选格子查看 · 滚轮缩放 · 空格 + 拖动平移':'按住拖动雕刻 · 空格 + 拖动平移 · Ctrl Z 撤销';
  canvas.style.cursor=panMode||space?'grab':tool==='inspect'?'crosshair':'none';
  requestDraw();
}
function paint(p) {
  if(!p)return;
  editTerrain(heights,p.u,p.v,{mode:tool,radius,strength,target});
  dirty=true;hover={...p,h:heightAt(heights,p.u,p.v)};refreshSelection();requestDraw();
}
function localPoint(event) {const r=canvas.getBoundingClientRect();return {x:event.clientX-r.left,y:event.clientY-r.top};}
canvas.addEventListener('pointerdown',e=>{
  if(e.button!==0&&e.button!==1)return;
  const p=localPoint(e);pointers.set(e.pointerId,p);canvas.setPointerCapture(e.pointerId);canvas.focus({preventScroll:true});
  if(pointers.size===2) {
    clearTimeout(touchPaintTimer);
    if(painting&&gesture?.touch&&!gesture.moved){const original=history.pop();if(original)heights=original.heights;dirty=true;$('undo').disabled=!history.length;}
    painting=false;save();const [a,b]=[...pointers.values()];
    gesture={mode:'pinch',mid:{x:(a.x+b.x)/2,y:(a.y+b.y)/2},distance:Math.hypot(a.x-b.x,a.y-b.y),zoom,ox,oy};return;
  }
  const mode=space||panMode||e.button===1?'pan':tool==='inspect'?'inspect':'paint';
  gesture={mode,start:p,last:p,moved:false,touch:e.pointerType==='touch'};
  hover=hit(p.x,p.y);
  if(mode==='paint'&&hover){
    const begin=()=>{if(!gesture||gesture.mode!=='paint'||pointers.size!==1)return;remember();painting=true;paint(hover);lastPaint=performance.now();};
    if(e.pointerType==='touch')touchPaintTimer=setTimeout(begin,160);else begin();
  }
  if(mode==='pan')canvas.style.cursor='grabbing';
});
canvas.addEventListener('pointermove',e=>{
  const p=localPoint(e);if(pointers.has(e.pointerId))pointers.set(e.pointerId,p);
  if(gesture?.mode==='pinch'&&pointers.size===2) {
    const [a,b]=[...pointers.values()],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
    const z=Math.max(.12,Math.min(2.5,gesture.zoom*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,gesture.distance)));
    ox=mid.x-(gesture.mid.x-gesture.ox)*z/gesture.zoom;oy=mid.y-(gesture.mid.y-gesture.oy)*z/gesture.zoom;zoom=z;requestDraw();return;
  }
  if(gesture&&pointers.size===1){
    const dx=p.x-gesture.last.x,dy=p.y-gesture.last.y;
    if(Math.hypot(p.x-gesture.start.x,p.y-gesture.start.y)>4)gesture.moved=true;
    if(gesture.mode==='pan'||(gesture.mode==='inspect'&&gesture.moved)){ox+=dx;oy+=dy;requestDraw();}
    gesture.last=p;
    if(painting){hover=hit(p.x,p.y);if(performance.now()-lastPaint>32){paint(hover);lastPaint=performance.now();}}
  }else{hover=hit(p.x,p.y);requestDraw();}
});
function endPointer(e) {
  clearTimeout(touchPaintTimer);
  const p=localPoint(e);
  if(e.type==='pointerup'&&gesture?.mode==='paint'&&gesture.touch&&!painting&&pointers.size===1){remember();paint(hit(p.x,p.y));save();}
  if(gesture?.mode==='inspect'&&!gesture.moved)select(hit(p.x,p.y));
  pointers.delete(e.pointerId);
  if(painting){painting=false;save();}
  if(gesture?.mode==='pinch'&&pointers.size===1){const remaining=[...pointers.values()][0];gesture={mode:'pan',start:remaining,last:remaining,moved:true};}
  else if(!pointers.size){gesture=null;setTool(tool);}
  requestDraw();
}
canvas.addEventListener('pointerup',endPointer);canvas.addEventListener('pointercancel',endPointer);
canvas.addEventListener('pointerleave',()=>{if(!pointers.size){hover=null;requestDraw();}});
canvas.addEventListener('wheel',e=>{e.preventDefault();const p=localPoint(e);scaleAt(zoom*Math.exp(-e.deltaY*.0015),p.x,p.y);},{passive:false});
function paintFrame(time) {
  if(painting&&hover&&time-lastPaint>90){paint(hover);lastPaint=time;}
  lastFrame=time;requestAnimationFrame(paintFrame);
}
requestAnimationFrame(paintFrame);
document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>{
  remember();preset=b.dataset.preset;heights=createTerrain(preset);selection=null;hover=null;
  $('selection').lastElementChild.textContent='点选地块，查看标高与坡度';dirty=true;updatePresets();fit();save();
}));
$('undo').addEventListener('click',undo);
$('reset').addEventListener('click',()=>{remember();heights=createTerrain(preset);dirty=true;refreshSelection();fit();save();toast('已恢复当前地形底稿，可撤销');});
$('radius').addEventListener('input',e=>{radius=+e.target.value;$('radius-value').textContent=radius.toFixed(1)+' m';requestDraw();});
$('strength').addEventListener('input',e=>{strength=+e.target.value;$('strength-value').textContent=tool==='smooth'||tool==='flatten'?Math.round(strength*100)+'%':strength.toFixed(2)+' m';});
$('target').addEventListener('change',e=>{target=Number.isFinite(+e.target.value)?Math.max(-1.5,Math.min(8,+e.target.value)):1.5;e.target.value=target;});
$('interval').addEventListener('change',e=>{interval=+e.target.value;dirty=true;requestDraw();});
$('grid').addEventListener('change',e=>{showGrid=e.target.checked;requestDraw();});
$('contours').addEventListener('change',e=>{showContours=e.target.checked;requestDraw();});
$('water').addEventListener('change',e=>{showWater=e.target.checked;refreshSelection();requestDraw();});
$('zoom-in').addEventListener('click',()=>scaleAt(zoom*1.2));$('zoom-out').addEventListener('click',()=>scaleAt(zoom/1.2));
$('zoom-value').addEventListener('click',()=>scaleAt(1));$('fit').addEventListener('click',fit);
$('pan').addEventListener('click',()=>{panMode=!panMode;$('pan').setAttribute('aria-pressed',String(panMode));setTool(tool);});
window.addEventListener('keydown',e=>{
  if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}
  if(e.code==='Space'){e.preventDefault();space=true;setTool(tool);}
  if(e.target===canvas&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();ox+=e.key==='ArrowLeft'?35:e.key==='ArrowRight'?-35:0;oy+=e.key==='ArrowUp'?35:e.key==='ArrowDown'?-35:0;requestDraw();
  }
  if(e.target===canvas&&['+','=','-'].includes(e.key)){e.preventDefault();scaleAt(zoom*(e.key==='-'?1/1.2:1.2));}
  if(e.key==='Escape'){selection=null;hover=null;$('selection').lastElementChild.textContent='点选地块，查看标高与坡度';setTool('inspect');}
});
window.addEventListener('keyup',e=>{if(e.code==='Space'){space=false;setTool(tool);}});
window.addEventListener('blur',()=>{space=false;painting=false;clearTimeout(touchPaintTimer);pointers.clear();gesture=null;persistNow();setTool(tool);});
window.addEventListener('pagehide',persistNow);
document.addEventListener('visibilitychange',()=>{if(document.hidden)persistNow();});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();painting=false;persistNow();toast('图形上下文暂时丢失，刷新可恢复已保存地形');});
updatePresets();setTool(tool);new ResizeObserver(resize).observe(box);

// Read-only diagnostics for unit-scale, projection and browser acceptance checks.
Object.defineProperty(window,'terrainPrototype',{value:Object.freeze({
  getState:()=>({preset,tool,radius,strength,target,interval,showGrid,showContours,showWater,zoom,ox,oy,width,height,selection:selection&&{...selection},history:history.length,heights:Array.from(heights),renderer:gl?'WebGL':'Canvas2D'}),
  project:(u,v,h=heightAt(heights,u,v))=>project(u,v,h,zoom,ox,oy),
  pick:(x,y)=>hit(x,y)
})});

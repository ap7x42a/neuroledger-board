// Shared by signed clients, storage, the public viewer and standalone local previews.
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const keys=(v,allowed)=>record(v)&&Object.keys(v).every(k=>allowed.includes(k));
const invalid=()=>{throw new Error('Invalid canvas effect. Use 2–16 lowercase #rrggbb colors, a supported mode and a bounded period.');};

export function normalizeEffects(input) {
  if(!record(input)||Object.keys(input).length<1||Object.keys(input).length>64)invalid();
  const entries=[];
  for(const name of Object.keys(input).sort()) {
    const def=input[name];
    if(!/^[A-Za-z0-9_-]{1,40}$/.test(name)||!keys(def,['colors','period_ms','mode'])||Object.keys(def).length!==3
      ||!Array.isArray(def.colors)||def.colors.length<2||def.colors.length>16
      ||!def.colors.every(c=>typeof c==='string'&&/^#[0-9a-f]{6}$/.test(c))
      ||!['loop','pingpong','blend','twinkle'].includes(def.mode))invalid();
    const steps=def.mode==='twinkle'?1:def.mode==='pingpong'?2*(def.colors.length-1):def.colors.length;
    if(!integer(def.period_ms,Math.max(1000,steps*250),86400000))invalid();
    entries.push([name,{colors:[...def.colors],period_ms:def.period_ms,mode:def.mode}]);
  }
  return Object.fromEntries(entries);
}

export function normalizeEffectRef(input,effects) {
  if(!keys(input,['effect','phase','step'])||typeof input.effect!=='string'||!record(effects)||!Object.hasOwn(effects,input.effect))invalid();
  const phase=input.phase===undefined?0:input.phase,step=input.step===undefined?0:input.step;
  if(!integer(phase,0,255)||!integer(step,0,255))invalid();
  return {effect:input.effect,phase,step};
}

// Self-contained so the exact same evaluator can be embedded in an offline HTML preview.
export function effectColor(definition,timeMs,phase=0) {
  const {colors,period_ms,mode}=definition,clock=timeMs/period_ms+phase/256;
  const t=((clock%1)+1)%1,n=colors.length;
  const rgb=color=>[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];
  if(mode==='loop')return rgb(colors[Math.min(n-1,Math.floor(t*n))]);
  if(mode==='pingpong') {
    const i=Math.floor(t*2*(n-1));return rgb(colors[i<n?i:2*(n-1)-i]);
  }
  let a,b,mix;
  if(mode==='twinkle') {
    a=rgb(colors[0]);const cycle=((Math.floor(clock)%(n-1))+(n-1))%(n-1);
    b=rgb(colors[1+cycle]);mix=t<.7?0:Math.sin(Math.PI*(t-.7)/.3)**2;
  }else {
    const position=t*n,index=Math.floor(position);a=rgb(colors[index]);b=rgb(colors[(index+1)%n]);mix=position-index;
  }
  return a.map((c,i)=>Math.round(c+(b[i]-c)*mix));
}

export const EFFECT_PRESETS=Object.freeze(Object.fromEntries(Object.entries({
  twinkle:{colors:['#28394e','#e6f2ff','#8db9e3'],period_ms:6000,mode:'twinkle'},
  ripple:{colors:['#12364f','#19566e','#4794a2','#1d627e'],period_ms:5000,mode:'blend'},
  embers:{colors:['#521508','#a72d0b','#ef7520','#ffb84b'],period_ms:4000,mode:'blend'},
  neon:{colors:['#5c2fb4','#d72da4','#27bccc','#5c2fb4'],period_ms:6000,mode:'blend'}
}).map(([name,def])=>[name,Object.freeze({...def,colors:Object.freeze(def.colors)})])));

function previewData(plan) {
  if(!keys(plan,['version','runs','effects'])||![1,2].includes(plan.version)||!Array.isArray(plan.runs)||plan.runs.length>262144
    ||plan.version===1&&Object.hasOwn(plan,'effects'))throw new Error('Invalid drawing plan.');
  const effects=plan.version===2?normalizeEffects(plan.effects):null,used=new Set(),occupied=new Uint8Array(2048*2048);
  let left=2048,top=2048,right=0,bottom=0,total=0;
  const runs=plan.runs.map(run=>{
    if(!Array.isArray(run)||![4,5].includes(run.length)||!integer(run[0],0,2047)||!integer(run[1],0,2047)
      ||!integer(run[2],1,2048)||run[0]+run[2]>2048||typeof run[3]!=='string'||!/^#[0-9a-f]{6}$/.test(run[3]))throw new Error('Invalid drawing run.');
    const [x,y,length,color]=run;total+=length;if(total>2048*2048)throw new Error('Drawing is too large.');
    for(let i=0;i<length;i++){const at=y*2048+x+i;if(occupied[at])throw new Error('Drawing runs overlap.');occupied[at]=1;}
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+length);bottom=Math.max(bottom,y+1);
    if(run.length===4)return [x,y,length,color];
    if(!effects)throw new Error('Animation needs a version 2 drawing plan.');
    const ref=normalizeEffectRef(run[4],effects);used.add(ref.effect);return [x,y,length,color,ref];
  });
  if(effects&&Object.keys(effects).some(name=>!used.has(name)))throw new Error('Drawing contains unused effects.');
  return {runs,effects,left:runs.length?left:0,top:runs.length?top:0,width:runs.length?right-left:1,height:runs.length?bottom-top:1};
}

function previewRuntime(data,colorAt) {
  const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),button=document.querySelector('button');
  canvas.width=data.width;canvas.height=data.height;
  const base=ctx.createImageData(data.width,data.height),image=ctx.createImageData(data.width,data.height);
  const total=data.runs.reduce((n,run)=>n+(run[4]?run[2]:0),0),positions=new Uint32Array(total),codes=new Uint16Array(total);
  const imageWords=new Uint32Array(image.data.buffer),littleEndian=new Uint8Array(new Uint32Array([1]).buffer)[0]===1;
  let cursor=0;
  const definitions=Object.values(data.effects||{}),names=Object.keys(data.effects||{});
  for(let i=0;i<base.data.length;i+=4){base.data[i]=8;base.data[i+1]=8;base.data[i+2]=12;base.data[i+3]=255;}
  for(const [x,y,length,color,ref] of data.runs) {
    const rgb=[parseInt(color.slice(1,3),16),parseInt(color.slice(3,5),16),parseInt(color.slice(5,7),16)];
    for(let i=0;i<length;i++) {
      const at=((y-data.top)*data.width+x-data.left+i)*4;base.data.set([...rgb,255],at);
      if(ref){positions[cursor]=at/4;codes[cursor++]=(names.indexOf(ref.effect)<<8)|((ref.phase+i*ref.step)&255);}
    }
  }
  image.data.set(base.data);ctx.putImageData(image,0,0);
  const preference=matchMedia('(prefers-reduced-motion: reduce)');
  let paused=preference.matches,userChoice=false,raf=0,last=0,frame=0,closed=false;
  const label=()=>{button.textContent=total?(paused?'Play animation':'Pause animation'):'Static drawing';button.disabled=!total;button.setAttribute('aria-pressed',String(!paused&&!!total));};
  function render(time) {
    const tables=definitions.map(def=>Uint32Array.from({length:256},(_,phase)=>{const [r,g,b]=colorAt(def,time,phase);return littleEndian?((255<<24)|(b<<16)|(g<<8)|r):((r<<24)|(g<<16)|(b<<8)|255);}));
    for(let i=0;i<total;i++)imageWords[positions[i]]=tables[codes[i]>>>8][codes[i]&255];
    ctx.putImageData(image,0,0);canvas.dataset.frame=String(++frame);
  }
  function tick(now) {
    raf=0;if(closed||paused||document.hidden||!total)return;
    if(now-last>=66){last=now;render(Date.now());}raf=requestAnimationFrame(tick);
  }
  function sync(){if(raf)cancelAnimationFrame(raf);raf=0;label();if(!closed&&!paused&&!document.hidden&&total)raf=requestAnimationFrame(tick);}
  button.addEventListener('click',()=>{userChoice=true;paused=!paused;sync();});
  const changed=()=>{if(!userChoice){paused=preference.matches;if(paused){image.data.set(base.data);ctx.putImageData(image,0,0);}sync();}};
  preference.addEventListener('change',changed);document.addEventListener('visibilitychange',sync);
  addEventListener('pagehide',()=>{closed=true;sync();preference.removeEventListener('change',changed);document.removeEventListener('visibilitychange',sync);},{once:true});
  sync();
}

export function animationPreviewHTML(plan,{title='Drawing preview'}={}) {
  const data=previewData(plan);
  if(typeof title!=='string'||title.length>200)throw new Error('Preview title must be at most 200 characters.');
  const escaped=title.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const json=JSON.stringify(data).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped}</title>
<style>body{color:#e3e7eb;background:#101319;font:16px system-ui;margin:24px}main{max-width:1100px;margin:auto}h1{font-size:1.3rem}canvas{display:block;image-rendering:pixelated;max-width:100%;max-height:75vh;width:auto;height:auto;min-width:min(100%,480px);object-fit:contain;background:#08080c;border:1px solid #39414d}button{font:inherit;padding:8px 14px;background:#263445;color:inherit;border:1px solid #58677b;border-radius:5px}p{color:#aeb9c6;line-height:1.5}</style>
<main><h1>${escaped}</h1><p>Local preview · no paint submitted · ${data.width} × ${data.height} pixels</p><canvas aria-label="Animated drawing preview"></canvas><p><button type="button">${data.effects?'Pause animation':'Static drawing'}</button></p><p>Motion follows your reduced-motion preference. Playing this preview uses no allowance or network requests.</p></main>
<script type="application/json" id="drawing-data">${json}</script><script>(${previewRuntime.toString()})(JSON.parse(document.getElementById('drawing-data').textContent),${effectColor.toString()});</script></html>`;
}

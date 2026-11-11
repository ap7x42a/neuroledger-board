#!/usr/bin/env node
// Local data-only build journal. The server receives signed runs, never a script.
import { createHash,randomUUID } from 'node:crypto';
import { constants,openSync,closeSync,readSync,writeFileSync,fsyncSync,fstatSync,lstatSync,mkdirSync,renameSync,unlinkSync,realpathSync,linkSync,readdirSync,rmdirSync } from 'node:fs';
import { join,dirname,basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeEffects,normalizeEffectRef,animationPreviewHTML } from './canvas-effects.mjs';
import { BASE,HOME,loadIdentity,readCanvas,previewCanvas,paintCanvas,canvasBatch,safeDisplay } from './client.mjs';

const MAX_PLAN=16*1024*1024,MAX_JOURNAL=32*1024*1024,MAX_RUNS=262144,MAX_PIXELS=2048*2048;
const integer=(n,lo=0,hi=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fields=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>names.includes(k));
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(id);
function exists(path) {try{return lstatSync(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function readJSON(path,limit) {
  const before=lstatSync(path);if(!before.isFile()||before.size>limit)throw new Error('Use a bounded regular JSON file, without symlinks.');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>limit||stat.ino!==before.ino||stat.dev!==before.dev)throw new Error('Use a bounded regular JSON file, without symlinks.');
    const bytes=Buffer.alloc(limit+1);let size=0,n;
    while(size<bytes.length&&(n=readSync(fd,bytes,size,bytes.length-size,null)))size+=n;
    if(size>limit)throw new Error('JSON file exceeds size limit.');return JSON.parse(bytes.subarray(0,size).toString('utf8'));
  }finally{closeSync(fd);}
}
function save(path,value) {
  const previous=exists(path);if(previous&&!previous.isFile())throw new Error('Build journal must be a regular file.');
  const data=JSON.stringify(value);if(Buffer.byteLength(data)>MAX_JOURNAL)throw new Error('Build journal exceeds size limit.');
  const temp=path+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
  try{renameSync(temp,path);}catch(e){unlinkSync(temp);throw e;}
}
const sameFile=(a,b)=>a&&b&&a.ino===b.ino&&a.dev===b.dev;
const lockToken=token=>typeof token==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(token);
function ownerAlive(pid) {
  if(!integer(pid,1))throw new Error('Invalid build lock owner; inspect it locally.');
  try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
}
function publishLock(path) {
  // Publish complete owner metadata atomically: death during writing leaves only
  // an unreferenced unique temp, never an ownerless lock or reaper marker.
  const token=randomUUID(),temp=path+'.'+token+'.tmp',fd=openSync(temp,'wx',0o600);
  let stat;
  try{writeFileSync(fd,JSON.stringify({pid:process.pid,token}));fsyncSync(fd);stat=fstatSync(fd);linkSync(temp,path);}
  finally{try{closeSync(fd);}finally{unlinkSync(temp);}}
  let released=false;
  return ()=>{
    if(released)return;released=true;
    if(sameFile(exists(path),stat)&&readJSON(path,1024).token===token)unlinkSync(path);
  };
}
function claimReaper(path) {
  // Unique intent names carry ownership at mkdir's atomic publication point.
  // Every contender publishes BEFORE scanning. Overlap can make both retry,
  // but cannot let both enter; a later starter sees the incumbent's live claim.
  // Dead claims are never reused, so their removal needs no recursive lock.
  const directory=dirname(path),prefix=basename(path)+'.reaper-',name=prefix+process.pid+'-'+randomUUID(),mine=join(directory,name);
  mkdirSync(mine,{mode:0o700});
  try{
    for(const entry of readdirSync(directory)){
      if(entry===name||!entry.startsWith(prefix))continue;
      const match=/^(\d+)-(.+)$/.exec(entry.slice(prefix.length));
      if(!match||!lockToken(match[2]))throw new Error('Invalid build reaper claim; inspect it locally.');
      if(ownerAlive(Number(match[1])))throw new Error('Build is locked by another running reaper.');
      try{rmdirSync(join(directory,entry));}catch(e){if(e.code!=='ENOENT')throw e;}
    }
  }catch(e){rmdirSync(mine);throw e;}
  return ()=>rmdirSync(mine);
}
function lock(path) {
  const old=exists(path);
  if(!old)return publishLock(path);
  const owner=readJSON(path,1024);
  if(ownerAlive(owner.pid))throw new Error('Build is locked by another running process.');
  const releaseClaim=claimReaper(path);let releaseReaper;
  try{
    // Keep the legacy inode-scoped marker to exclude older helpers too. An old
    // empty marker has no provable owner: leave it for explicit local inspection.
    const reap=path+'.'+old.ino+'.reap',previous=exists(reap);
    if(previous){
      let reaper;try{reaper=readJSON(reap,1024);}catch(e){if(e instanceof SyntaxError)throw new Error('Unowned legacy build reaper; stop old helpers and inspect it locally.');throw e;}
      if(!lockToken(reaper.token))throw new Error('Invalid build reaper owner; inspect it locally.');
      if(ownerAlive(reaper.pid))throw new Error('Build is locked by another running reaper.');
      if(!sameFile(exists(reap),previous))throw new Error('Build reaper changed; retry.');
      unlinkSync(reap);
    }
    releaseReaper=publishLock(reap);
    if(!sameFile(exists(path),old))throw new Error('Build lock changed; retry.');
    const current=readJSON(path,1024);
    if(current.pid!==owner.pid||current.token!==owner.token)throw new Error('Build lock changed; retry.');
    if(ownerAlive(current.pid))throw new Error('Build is locked by another running process.');
    unlinkSync(path);
    return publishLock(path);
  }finally{try{releaseReaper?.();}finally{releaseClaim();}}
}
export function validatePlan(plan) {
  if(!fields(plan,['version','runs','effects'])||![1,2].includes(plan.version)||!Array.isArray(plan.runs)||!plan.runs.length||plan.runs.length>MAX_RUNS||plan.version===1&&'effects' in plan||plan.version===2&&!('effects' in plan))throw new Error('Invalid drawing plan: use version 1 static or version 2 effects and 1–262144 runs only.');
  const effects=plan.version===2?normalizeEffects(plan.effects):undefined,used=new Set();
  const runs=plan.runs.map(r=>{
    if(!Array.isArray(r)||!(r.length===4||r.length===5&&effects)||!integer(r[0],0,2047)||!integer(r[1],0,2047)||!integer(r[2],1,2048-r[0])||typeof r[3]!=='string'||!/^#[0-9a-f]{6}$/.test(r[3]))throw new Error('Invalid drawing plan run.');
    const result=r.slice(0,4);if(r.length===5){const ref=normalizeEffectRef(r[4],effects);used.add(ref.effect);result.push(ref);}return result;
  }).sort((a,b)=>a[1]-b[1]||a[0]-b[0]);
  for(let i=1;i<runs.length;i++)if(runs[i][1]===runs[i-1][1]&&runs[i][0]<runs[i-1][0]+runs[i-1][2])throw new Error('Drawing plan runs overlap.');
  if(effects&&Object.keys(effects).some(name=>!used.has(name)))throw new Error('Unused drawing effect definition.');
  return {version:plan.version,runs,...(effects?{effects}:{})};
}
export function chunkPlan(plan,state) {
  const {policy,limits}=state;
  if(!policy||!limits||!integer(policy.max_batch_pixels,1,65536)||!integer(limits.runs,1,512)||!integer(policy.width,1,2048)||!integer(policy.height,1,2048))throw new Error('Invalid server canvas limits.');
  // Reserve 4 KiB for the bounded ticket, signatures, guard and request envelope.
  const bodyLimit=integer(limits.requestBytes,8192,1048576)?Math.min(limits.requestBytes,65536):65536;
  const chunks=[];let runs=[],pixels=0;
  const definitions=rows=>Object.fromEntries([...new Set(rows.filter(r=>r[4]).map(r=>r[4].effect))].sort().map(name=>[name,plan.effects[name]]));
  const data=rows=>{const effects=definitions(rows);return {runs:rows,...(Object.keys(effects).length?{effects}:{})};};
  const flush=()=>{if(runs.length)chunks.push({...data(runs),attempts:[]});runs=[];pixels=0;};
  for(const [start,y,length,color,ref] of plan.runs){
    if(start+length>policy.width||y>=policy.height)throw new Error('Drawing plan exceeds the canvas bounds.');
    for(let x=start,left=length;left;){
      if(pixels===policy.max_batch_pixels||runs.length===limits.runs)flush();
      const count=Math.min(left,policy.max_batch_pixels-pixels),run=[x,y,count,color,...(ref?[{...ref,phase:(ref.phase+(x-start)*ref.step)%256}]:[])];
      if(Buffer.byteLength(JSON.stringify(data([...runs,run])))>bodyLimit-4096){if(!runs.length)throw new Error('Effect batch exceeds signed request body limit.');flush();continue;}
      runs.push(run);pixels+=count;x+=count;left-=count;
    }
  }
  flush();return chunks;
}
const payload=(j,i,guard)=>({batch_id:`build-${j.id}-${i}`,runs:j.chunks[i].runs,...(j.chunks[i].effects?{effects:j.chunks[i].effects}:{}),guard});
const done=c=>Boolean(c.receipt||c.skipped);
const spent=j=>j.chunks.reduce((n,c)=>n+(c.receipt?.pixels??0),0);
function summary(j) {
  const completed=j.chunks.filter(done).length,last=j.chunks.filter(c=>c.receipt).at(-1)?.receipt;
  return {build_id:j.id,status:completed===j.chunks.length?'complete':j.status,max_pixels:j.max_pixels,spent_pixels:spent(j),
    total_batches:j.chunks.length,completed_batches:completed,remaining_batches:j.chunks.length-completed,
    ...(j.quote?{quote_id:j.quote.id,cost_pixels:j.quote.cost,expires_ms:j.quote.expires_ms}:{}),
    ...(last?{remaining_after:last.remaining_after}:{}),
    ...(j.preview_file?{preview_file:j.preview_file}:{}),
    ...(j.error_code?{error_code:j.error_code}:{}),...(j.retry_after?{retry_after:j.retry_after}:{}),
    ...(j.chunks.some(c=>c.pending)?{unresolved_batches:j.chunks.filter(c=>c.pending).length}:{})};
}
// Previous owners and the pixels taken from each; the painter is never listed.
function validOverpainted(o,painter,max) {
  if(!o||typeof o!=='object'||Array.isArray(o))return false;
  let total=0;
  for(const [owner,n] of Object.entries(o)){if(!/^[a-z][a-z0-9_]{2,31}$/.test(owner)||owner===painter||!integer(n,1,max))return false;total+=n;}
  return total<=max;
}
function acceptReceipt(j,i,r) {
  const c=j.chunks[i],b=r?.batch,guard=c.attempts.find(g=>hash(payload(j,i,g))===b?.payload_hash);
  if(r?.type!=='canvas_painted'||!guard||b.handle!==j.handle||b.batch_id!==`build-${j.id}-${i}`||!integer(b.pixels,1,guard.max_pixels)||b.revision!==guard.revision+1
    ||!validOverpainted(b.overpainted,j.handle,b.pixels)||!integer(r.remaining_after))throw new Error('Unverified canvas receipt; keep the journal and inspect the batch.');
  c.receipt={batch_id:b.batch_id,payload_hash:b.payload_hash,pixels:b.pixels,revision:b.revision,remaining_after:r.remaining_after};c.pending=false;
}
async function reconcile(j,write) {
  for(let i=0;i<j.chunks.length;i++){
    const c=j.chunks[i];if(c.receipt||!c.attempts.length)continue;
    const receipt=await canvasBatch(`build-${j.id}-${i}`);if(receipt){acceptReceipt(j,i,receipt);write();}
  }
  if(j.status==='unknown'&&!j.chunks.some(c=>c.pending)){j.status='ready';delete j.error_code;delete j.retry_after;write();}
  if(j.chunks.every(done)){j.status='complete';delete j.error_code;delete j.retry_after;write();}
}
function checkPreview(q,requested,painter) {
  if(!q||!integer(q.revision)||!integer(q.expires_ms)||!integer(q.changed_pixels,0,requested)||q.no_op_pixels!==requested-q.changed_pixels||q.requested_pixels!==requested
    ||!validOverpainted(q.overpainted,painter,q.changed_pixels)||!integer(q.allowance?.remaining)
    ||typeof q.can_paint!=='boolean'||typeof q.enabled!=='boolean'||typeof q.paused!=='boolean')throw new Error('Invalid server canvas preview.');
}
async function quote(j,write) {
  let state;try{state=await readCanvas();}catch(e){return stop(j,write,'preview_incomplete',typeof e.code==='string'?e.code.slice(0,80):'canvas_preview_unavailable',e.retryAfter);}
  if(!integer(state.revision))throw new Error('Invalid server canvas revision.');
  // Cache partial quote reads so large/complex plans can continue after a read throttle.
  const stateHash=hash({revision:state.revision,policy:state.policy_version,remaining:state.allowance?.remaining,paused:state.paused});
  if(!j.preview||j.preview.state_hash!==stateHash||j.preview.expires_ms<=Date.now())j.preview={revision:state.revision,state_hash:stateHash,expires_ms:Date.now()+300000,parts:{}};
  let revision=null,expiry=Infinity,cost=0,remaining=Infinity,blocked=false;const costs=[];
  delete j.error_code;delete j.retry_after;
  for(let i=0;i<j.chunks.length;i++){
    const c=j.chunks[i];if(done(c)){costs.push(null);continue;}
    let q=j.preview.parts[i];
    if(!q){
      try{q=await previewCanvas(c.runs,{effects:c.effects});}catch(e){delete j.quote;return stop(j,write,'preview_incomplete',typeof e.code==='string'?e.code.slice(0,80):'canvas_preview_unavailable',e.retryAfter);}
      checkPreview(q,c.runs.reduce((n,r)=>n+r[2],0),j.handle);
      if(q.revision!==j.preview.revision){j.status='needs_preview';j.error_code='canvas_quote_stale';delete j.quote;delete j.preview;write();return summary(j);}
      q={revision:q.revision,expires_ms:q.expires_ms,changed_pixels:q.changed_pixels,no_op_pixels:q.no_op_pixels,requested_pixels:q.requested_pixels,
        allowance:{remaining:q.allowance.remaining},can_paint:q.can_paint,enabled:q.enabled,paused:q.paused};
      j.preview.parts[i]=q;j.preview.expires_ms=Math.min(j.preview.expires_ms,q.expires_ms);write();
    }
    revision=q.revision;expiry=Math.min(expiry,q.expires_ms);cost+=q.changed_pixels;costs.push(q.changed_pixels);remaining=Math.min(remaining,q.allowance.remaining);
    blocked||=q.changed_pixels>0&&!q.can_paint;
  }
  if(cost+spent(j)>j.max_pixels){blocked=true;j.error_code='canvas_spend_limit';}
  else if(cost>remaining){blocked=true;j.error_code='canvas_allowance_exceeded';}
  else if(blocked)j.error_code='canvas_not_ready';
  j.quote={revision,expires_ms:expiry,cost,costs};j.quote.id=hash({plan:j.plan_hash,build:j.id,...j.quote});delete j.preview;j.status=blocked?'blocked':'ready';write();return summary(j);
}
function stop(j,write,status,code,retry) {j.status=status;j.error_code=code;if(retry)j.retry_after=retry;else delete j.retry_after;write();return summary(j);}
async function commitBuild(j,write) {
  if(j.status==='blocked')return summary(j);
  const q=j.quote,state=await readCanvas(),expected=j.chunks.filter(c=>c.receipt).at(-1)?.receipt.revision;
  // A new quote starts at its own revision. A resumed quote includes our completed writes.
  let revision=Math.max(q.revision,expected??q.revision);
  if(Date.now()>=q.expires_ms)return stop(j,write,'needs_preview','canvas_quote_expired');
  if(state.revision!==revision)return stop(j,write,'needs_preview','canvas_quote_stale');
  for(let i=0;i<j.chunks.length;i++){
    const c=j.chunks[i];if(done(c))continue;
    const max=q.costs[i];if(!integer(max,0,65536))return stop(j,write,'needs_preview','canvas_quote_stale');
    if(max===0){if((await readCanvas()).revision!==revision)return stop(j,write,'needs_preview','canvas_quote_stale');c.skipped=true;write();continue;}
    if(max+spent(j)>j.max_pixels)return stop(j,write,'needs_preview','canvas_spend_limit');
    const guard={revision,expires_ms:q.expires_ms,max_pixels:max};
    if(!c.attempts.some(g=>hash(g)===hash(guard)))c.attempts.push(guard);
    c.pending=true;write();
    try {
      acceptReceipt(j,i,await paintCanvas(`build-${j.id}-${i}`,c.runs,{guard,effects:c.effects,attempts:1}));revision=c.receipt.revision;write();
    }catch(e){
      // A lost response or malformed receipt may follow a committed write. Preserve the attempt.
      if(!e.status||e.status>=500)return stop(j,write,'unknown',typeof e.code==='string'?e.code.slice(0,80):'canvas_outcome_unknown',e.retryAfter);
      c.pending=false;
      if(e.code==='canvas_batch_conflict'){
        try{await reconcile(j,write);}catch{return stop(j,write,'unknown','canvas_receipt_conflict');}
      }
      return stop(j,write,'needs_preview',typeof e.code==='string'?e.code.slice(0,80):'canvas_refused',e.retryAfter);
    }
  }
  j.status='complete';delete j.error_code;delete j.retry_after;write();return summary(j);
}

export async function canvasBuild(options) {
  if(!fields(options,['mode','plan_file','max_pixels','build_id','quote_id'])||!['preview','commit','status'].includes(options.mode))throw new Error('Choose preview, commit or status.');
  const {mode,plan_file,max_pixels,quote_id}=options;
  if(mode!=='preview'&&(plan_file!==undefined||max_pixels!==undefined)||mode!=='commit'&&quote_id!==undefined)throw new Error('Unexpected build options.');
  if(mode==='commit'&&process.env.NEUROLEDGER_BOARD_ALLOW_WRITES!=='1')throw new Error('Writes require explicit local configuration NEUROLEDGER_BOARD_ALLOW_WRITES=1.');
  const identity=loadIdentity();if(!identity)throw new Error('Register an identity before building.');
  const id=options.build_id??(mode==='preview'?randomUUID():null);if(!validId(id))throw new Error('Use a build_id of 1–40 letters, digits, underscores or hyphens.');
  const directory=join(HOME,'builds');mkdirSync(directory,{recursive:true,mode:0o700});if(!lstatSync(directory).isDirectory())throw new Error('Build directory must not be a symlink.');
  const path=join(directory,id+'.json'),planPath=join(directory,id+'.plan.json'),release=lock(join(directory,id+'.lock'));
  try {
    let j;
    if(exists(path)){
      j=readJSON(path,MAX_JOURNAL);
      if(j.version!==1||j.server!==BASE||j.handle!==identity.handle||j.id!==id||!integer(j.max_pixels,0,MAX_PIXELS)||!Array.isArray(j.chunks)||!j.chunks.length||j.chunks.length>MAX_RUNS)throw new Error('Invalid or foreign build journal.');
      if(max_pixels!==undefined&&max_pixels!==j.max_pixels)throw new Error('A build keeps its original spend bound; use a new ID for new intent.');
      if(plan_file!==undefined&&hash(validatePlan(readJSON(plan_file,MAX_PLAN)))!==j.plan_hash)throw new Error('Build ID already belongs to a different plan.');
      const stored=readJSON(planPath,MAX_JOURNAL);
      if(!Array.isArray(stored)||stored.length!==j.chunks.length||hash(stored)!==j.chunks_hash)throw new Error('Build plan changed; keep the original plan.');
      j.chunks.forEach((c,i)=>{if(Array.isArray(stored[i]))c.runs=stored[i];else {c.runs=stored[i].runs;c.effects=stored[i].effects;}});
    }else{
      if(mode!=='preview'||typeof plan_file!=='string'||!integer(max_pixels,0,MAX_PIXELS))throw new Error('Start with preview, plan_file and max_pixels (0–4194304).');
      const plan=validatePlan(readJSON(plan_file,MAX_PLAN)),state=await readCanvas();
      const chunks=chunkPlan(plan,state),stored=chunks.map(c=>c.effects?{runs:c.runs,effects:c.effects}:c.runs);
      j={version:1,id,server:BASE,handle:identity.handle,plan_hash:hash(plan),max_pixels,chunks,chunks_hash:hash(stored),status:'new'};
      if(exists(planPath))throw new Error('An incomplete build already owns this ID; inspect it locally or choose another ID.');save(planPath,stored);
      const html=animationPreviewHTML(plan,{title:'Canvas build '+id});
      j.preview_file=join(directory,id+'.preview.html');
      try{writeFileSync(j.preview_file,html,{flag:'wx',mode:0o600});}catch(e){unlinkSync(planPath);throw e;}
    }
    const write=()=>save(path,{...j,chunks:j.chunks.map(({runs,effects,...c})=>c)});write();
    if(mode==='commit'&&(!j.quote||typeof quote_id!=='string'||j.quote.id!==quote_id))throw new Error('Use the exact quote_id from this build preview.');
    await reconcile(j,write);
    if(j.chunks.every(done))return summary(j);
    if(mode==='preview')return await quote(j,write);
    if(mode==='status')return summary(j);
    return await commitBuild(j,write);
  }finally{release();}
}

async function main() {
  const [mode,...args]=process.argv.slice(2),options={mode};
  const names={'--file':'plan_file','--max-pixels':'max_pixels','--build':'build_id','--quote':'quote_id'};
  for(let i=0;i<args.length;i+=2){const key=names[args[i]];if(!key||args[i+1]===undefined||key in options)throw new Error('Use preview --file plan.json --max-pixels N [--build ID], commit --build ID --quote ID, or status --build ID.');options[key]=key==='max_pixels'?Number(args[i+1]):args[i+1];}
  console.log(safeDisplay(JSON.stringify(await canvasBuild(options))));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)main().catch(e=>{console.error(safeDisplay(e.message));process.exitCode=1;});

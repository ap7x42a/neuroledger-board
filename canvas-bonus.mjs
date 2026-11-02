#!/usr/bin/env node
// The native finding/build/part receipts make retries safe without a second journal.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadIdentity,act,readCanvas,readCanvasBonus,safeDisplay} from './client.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function bonusBuild({mode='preview',finding_id,build_id,plan_file}={}) {
  if(!['preview','commit','status'].includes(mode)||!/^[a-zA-Z0-9_-]{1,96}$/.test(finding_id??'')||mode!=='status'&&!/^[a-zA-Z0-9_-]{1,64}$/.test(build_id??''))throw new Error('Use mode preview/commit/status, finding_id and build_id.');
  const identity=loadIdentity();if(!identity)throw new Error('A registered local identity is required');
  const state=await readCanvasBonus(finding_id);
  if(mode==='status')return {finding_id,available:state.available,max_pixels:state.max_pixels,percent:state.percent,build_id:state.draft?.build_id,parts:state.draft?.parts,received_parts:state.draft?.received.length,receipt:state.draft?.receipt};
  const file=await open(plan_file,constants.O_RDONLY|constants.O_NOFOLLOW);let plan;
  try{const stat=await file.stat();if(!stat.isFile()||stat.size>134217728)throw new Error('Use a regular JSON plan up to 128 MiB');plan=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
  if(plan.version!==1||!Array.isArray(plan.runs)||!plan.runs.length||plan.runs.length>4194304)throw new Error('Invalid drawing plan');
  const chunks=[];let chunk=[],pixels=0,total=0;
  for(const r of plan.runs){if(!Array.isArray(r))throw new Error('Invalid drawing run');const [x,y,n,color]=r;if(r.length!==4||![x,y,n].every(Number.isSafeInteger)||x<0||y<0||n<1||!/^#[a-f0-9]{6}$/.test(color))throw new Error('Invalid drawing run');
    if(chunk.length>=512||pixels+n>65536){chunks.push(chunk);chunk=[];pixels=0;}
    chunk.push(r);pixels+=n;total+=n;
  }if(chunk.length)chunks.push(chunk);
  const hashes=chunks.map(c=>hash(JSON.stringify(c))),plan_hash=hash(hashes.join('\n')),base={finding_id,build_id};
  // A committed plan is reconciled against its receipt, not today's canvas dimensions.
  if(mode==='commit'&&state.draft?.receipt){if(state.draft.build_id!==build_id||state.draft.plan_hash!==plan_hash)throw new Error('Bonus already consumed by another build');return state.draft.receipt;}
  const canvas=await readCanvas(),seen=new Uint8Array(canvas.policy.width*canvas.policy.height);
  for(const [x,y,n] of plan.runs){if(x+n>canvas.policy.width||y>=canvas.policy.height)throw new Error('Invalid drawing run');for(let i=0;i<n;i++){const at=y*canvas.policy.width+x+i;if(seen[at])throw new Error('Runs overlap');seen[at]=1;}}
  if(total>(state.max_pixels??canvas.policy.width*canvas.policy.height))throw new Error('Plan exceeds the awarded pixel budget');
  if(mode==='preview')return {finding_id,build_id,plan_hash,pixels:total,max_pixels:state.max_pixels,percent:state.percent,parts:chunks.length,available:state.available,consumes_on_success:1,daily_pixel_cost:0,xp:0};
  if(!state.available)throw new Error('Bonus unavailable');
  await act(identity,'begin_canvas_bonus',{...base,plan_hash,parts:chunks.length});
  const received=state.draft?.build_id===build_id?new Map(state.draft.received.map(r=>[r.part,r.hash])):new Map();
  for(let part=0;part<chunks.length;part++){if(received.get(part)===hashes[part])continue;await act(identity,'stage_canvas_bonus',{...base,part,runs:chunks[part]});}
  return (await act(identity,'commit_canvas_bonus',{...base,plan_hash})).body;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){try{console.log(safeDisplay(JSON.stringify(await bonusBuild(JSON.parse(process.argv[2]??'{}')))));}catch(e){console.error(e.message);process.exitCode=1;}}

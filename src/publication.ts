import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {git} from './execution.js';
import type {Configuration} from './config.js';
const exec=promisify(execFile);

// Only administrator targets and isolated exports enter this writer. Never run host Git in agent Git.
export async function publication(target:NonNullable<Configuration['repos'][number]['publication']>, source:string, directory:string, branch:string, baseSha:string, revision:{treeSha:string}, metadata:{title:string;body:string}, query=false, save:(facts:Record<string,unknown>)=>void=()=>{}) {
  if(!/^orch\/[a-f0-9-]+$/.test(branch))throw Error('Invalid dedicated branch');
  const env={PATH:process.env.PATH,...target.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'};
  const remote=async()=>String((await exec('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','ls-remote','--',target.remote,`refs/heads/${branch}`],{env})).stdout).trim().split(/\s+/)[0] || null;
  const prs=async()=>JSON.parse((await exec('gh',['api',`repos/${target.github}/pulls?state=open&head=${encodeURIComponent(target.github.split('/')[0]+':'+branch)}`],{env})).stdout);
  const validPr=(p:any,sha?:string)=>p?.draft===true && p.head?.ref===branch && p.head?.repo?.full_name===target.github && p.base?.repo?.full_name===target.github && p.base?.ref===target.base && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.head?.sha) && (!sha || p.head.sha===sha) && Number.isSafeInteger(p.number) && p.number>0 && p.html_url===`https://github.com/${target.github}/pull/${p.number}`;
  const before=await remote();const existing=await prs();
  if(query)save({queryObservation:{remoteSha:before,pullRequests:Array.isArray(existing)?existing.map((p:any)=>({number:p?.number,url:p?.html_url,draft:p?.draft,head:p?.head && {sha:p.head.sha,ref:p.head.ref,repo:p.head.repo?.full_name},base:p?.base && {ref:p.base.ref,repo:p.base.repo?.full_name}})):null,observedAt:new Date().toISOString()}});
  if(!Array.isArray(existing) || existing.some((p:any)=>!validPr(p)))throw Error('Existing PR context mismatch');
  if(query)return {operation:'query',branch,remote:target.remote,remoteSha:before,pullRequests:existing.map((p:any)=>({url:p.html_url,draft:p.draft,headSha:p.head?.sha,base:p.base?.ref})),observedAt:new Date().toISOString()};
  if(before || existing.length)throw Error('Existing branch or PR requires query and reconciliation; refusing replacement');
  await mkdir(directory,{mode:0o700});
  const sourceExport=join(directory,'..','revision');
  if(!(await lstat(directory)).isDirectory() || !(await lstat(sourceExport)).isDirectory())throw Error('Unsafe publication directory');
  await git(directory,['clone','--no-local','--no-checkout','--',source,'.']);
  await git(directory,['remote','remove','origin']);
  const entries:string[]=[];
  // Import only the isolated export, never the agent-writable Git directory.
  const objects=async(relative='')=>{for(const name of await readdir(join(sourceExport,relative))){const rel=join(relative,name),file=join(sourceExport,rel),stat=await lstat(file);if(name==='.git')throw Error('Unsafe export');if(stat.isDirectory()){await objects(rel);continue;}if(!stat.isFile())throw Error('Unsafe export');const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let bytes:Buffer;try{if(!(await fd.stat()).isFile())throw Error('Unsafe export');bytes=await fd.readFile()}finally{await fd.close()}const {spawn}=await import('node:child_process');const object=await new Promise<string>((resolve,reject)=>{const child=spawn('git',['-C',directory,'hash-object','-w','--stdin'],{env});let out='';child.stdout.on('data',d=>out+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(Error('Blob import failed')));child.stdin.end(bytes)});entries.push(`${stat.mode&0o111?'100755':'100644'} ${object}\t${rel}\0`);}};
  await objects();await git(directory,['read-tree','--empty']);
  const {spawn}=await import('node:child_process');
  await new Promise<void>((resolve,reject)=>{const child=spawn('git',['-C',directory,'update-index','-z','--index-info'],{env});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Tree import failed')));child.stdin.end(entries.join(''))});
  const tree=String((await git(directory,['write-tree'])).stdout).trim();if(tree!==revision.treeSha)throw Error('Published tree differs from tested revision');
  const sha=String((await exec('git',['-C',directory,'-c','user.name=Orchestrator','-c','user.email=orchestrator@localhost','commit-tree',tree,'-p',baseSha,'-m',metadata.title],{env})).stdout).trim();
  // Recheck the actual target immediately before the non-forced, single-ref write.
  if(await remote())throw Error('Remote branch changed before push');
  save({phase:'push',intended:{actualSha:sha,treeSha:tree,branch,remote:target.remote,baseSha}});
  await exec('git',['-c','core.hooksPath=/dev/null','-C',directory,'push','--',target.remote,`${sha}:refs/heads/${branch}`],{env});
  if(await remote()!==sha)throw Error('Push result could not be verified');
  save({phase:'draft-pr',pushReceipt:{actualSha:sha,treeSha:tree,branch,remote:target.remote,verifiedAt:new Date().toISOString()}});
  const pr=JSON.parse((await exec('gh',['api','--method','POST',`repos/${target.github}/pulls`,'-f',`title=${metadata.title}`,'-f',`body=${metadata.body}`,'-f',`head=${branch}`,'-f',`base=${target.base}`,'-F','draft=true'],{env})).stdout);
  save({prReceipt:{url:pr.html_url,number:pr.number,draft:pr.draft,head:pr.head && {sha:pr.head.sha,ref:pr.head.ref,repo:pr.head.repo?.full_name},base:pr.base && {ref:pr.base.ref,repo:pr.base.repo?.full_name}}});
  if(!validPr(pr,sha))throw Error('Draft PR receipt mismatch');
  return {operation:'publish',branch,remote:target.remote,actualSha:sha,treeSha:tree,draft:true,url:pr.html_url,observedAt:new Date().toISOString()};
}

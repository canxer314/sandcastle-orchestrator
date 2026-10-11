// Executed only inside the existing bound execute command lifecycle, never on the host.
export const revisionScript = String.raw`
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {execFileSync}=require('node:child_process');
const source=process.argv[2],output=process.argv[3];
const env={PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'};
const git=(cwd,args,input)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{env,input,maxBuffer:64*1024*1024});
const head=git(source,['rev-parse','--verify','HEAD^{commit}']).toString().trim();
if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))throw Error('Invalid HEAD');
if(git(source,['ls-tree','-r',head]).toString().split('\n').some(line=>line.startsWith('160000 ')))throw Error('Revision does not support submodules');
const commit=git(source,['cat-file','commit',head]);const algorithm=head.length===64?'sha256':'sha1';
const hash=(type,bytes)=>crypto.createHash(algorithm).update(type+' '+bytes.length+'\0').update(bytes).digest('hex');
if(hash('commit',commit)!==head)throw Error('HEAD object integrity failed');
const committedTree=commit.toString().match(/^tree ([a-f0-9]+)\n/)?.[1];if(!committedTree)throw Error('Missing committed tree');
const temp=fs.mkdtempSync('/tmp/orch-revision-');
git(temp,['init','--object-format='+algorithm]);
fs.mkdirSync(output,{recursive:true});const entries=[];
function walk(relative='') {
 for(const name of fs.readdirSync(path.join(source,relative)).sort()) {
  if(name==='.git') {if(relative)throw Error('Nested .git is unsupported');continue;}
  if(name.includes('\n') || name.includes('\t') || name.includes('\r'))throw Error('Unsupported snapshot filename');
  const rel=path.join(relative,name),from=path.join(source,rel),to=path.join(output,rel);const stat=fs.lstatSync(from);
  if(stat.isSymbolicLink())throw Error('Revision does not support symlinks');
  if(stat.isDirectory()){fs.mkdirSync(to,{recursive:true});walk(rel);continue;}
  if(!stat.isFile())throw Error('Revision requires regular files');
  const fd=fs.openSync(from,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let bytes,opened;try{opened=fs.fstatSync(fd);if(!opened.isFile())throw Error('Not regular');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
  const mode=opened.mode&0o111?'100755':'100644';const object=git(temp,['hash-object','-w','--stdin'],bytes).toString().trim();
  if(object!==hash('blob',bytes))throw Error('Blob integrity failed');
  fs.writeFileSync(to,bytes,{mode:mode==='100755'?0o700:0o600,flag:'wx'});entries.push(mode+' '+object+'\t'+rel+'\0');
 }
}
walk();git(temp,['update-index','-z','--index-info'],Buffer.from(entries.join('')));
const treeSha=git(temp,['write-tree']).toString().trim();
console.log(JSON.stringify({headSha:head,treeSha,committedTree,dirty:treeSha!==committedTree,collection:'non-atomic; tests use the isolated exported tree'}));
`;
export interface Revision {headSha:string;treeSha:string;committedTree:string;dirty:boolean;collection:string}
export function parseRevision(stdout:string):Revision {
  const value=JSON.parse(stdout.trim().split('\n').at(-1)!);
  if(!value || !['headSha','treeSha','committedTree'].every(key=>typeof value[key]==='string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[key])) || value.headSha.length!==value.treeSha.length || value.headSha.length!==value.committedTree.length || typeof value.dirty!=='boolean' || value.dirty!==(value.treeSha!==value.committedTree) || typeof value.collection!=='string')throw Error('Invalid revision receipt');
  return value;
}

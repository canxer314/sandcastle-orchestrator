// Explicit opt-in only. Uses an existing dedicated image/network and in-memory CC-Switch auth.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.ORCH_REAL_MCP, '1', 'Set ORCH_REAL_MCP=1 only in an authorized test environment');
const red = process.argv.includes('--without-mcp');
const root = resolve(import.meta.dirname, '..');
const image = 'issue-19-acceptance:2.1.296';
const docker = args => execFileSync('docker', args, {encoding:'utf8'}).trim();
assert.equal(docker(['image','inspect',image,'--format','{{.Id}}']), 'sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193');
assert.equal(docker(['network','inspect','issue-19-acceptance','--format','{{.Internal}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}']), 'true 10.231.19.0/28 10.231.19.1');
const host = JSON.parse(readFileSync('/home/canxer/.claude/settings.json','utf8'));
assert.ok(host.env?.ANTHROPIC_AUTH_TOKEN, 'Existing proxy authentication unavailable; no credential fallback');
const dir = mkdtempSync(join(tmpdir(),'issue-23-real-'));
const repo = join(dir,'repo'); mkdirSync(repo);
writeFileSync(join(repo,'context.txt'),'Non-sensitive readonly acceptance repository. Project: lighthouse.\n');
copyFileSync(join(root,'tests/fixtures/real-mcp-service.mjs'),join(repo,'service.mjs'));
const git = args => execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
git(['init','-q']); git(['add','.']); git(['-c','user.name=Acceptance','-c','user.email=acceptance@example.invalid','commit','-qm','Readonly acceptance fixture']);
const sha = git(['rev-parse','HEAD']);
writeFileSync(join(dir,'native.json'),JSON.stringify({mcpServers:{readonly:{command:'node',args:['/home/agent/workspace/service.mjs']}}}));
const config = join(dir,'config.mjs');
writeFileSync(config, `import {readFileSync} from 'node:fs';
import {claudeCode} from ${JSON.stringify(join(root,'node_modules/@ai-hero/sandcastle/dist/index.js'))};
import {configureClaudeMcp} from ${JSON.stringify(join(root,'src/mcp.ts'))};
const host=JSON.parse(readFileSync('/home/canxer/.claude/settings.json','utf8'));
const env=Object.fromEntries(Object.entries(host.env||{}).filter(([k])=>k==='ANTHROPIC_AUTH_TOKEN'||k.startsWith('ANTHROPIC_DEFAULT_')||k==='CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'));
env.ANTHROPIC_BASE_URL='http://10.231.19.1:15721';
export default {
version:'issue-23-real-v1',repos:[{id:'fixture',location:${JSON.stringify(repo)}}],capabilities:[],
environments:[{id:'readonly',docker:{image:${JSON.stringify(image)},network:'issue-19-acceptance',env}}],
providers:[{id:'cc-switch',agent:claudeCode('opus',{effort:'low',sessionStorage:{hostProjectsDir:${JSON.stringify(join(dir,'sessions'))}}}),configureMcp:configureClaudeMcp}],
mcpServices:[{id:'readonly',tools:['inspect'],access:'Dedicated readonly fixture; no credentials or external work',context:'none',capabilities:{context:null,directory:null,logs:null,longTasks:null,query:null,cancel:null,retry:null},async prepare(){return {configFile:${JSON.stringify(join(dir,'native.json'))}}}}],
roles:[{id:'report',description:'Readonly native MCP acceptance',validate(input){if(input!=='inspect')throw Error('Expected inspect');return input},buildPrompt(){return 'Only call the native MCP readonly inspect tool once, if available. Do not use Bash, files, web, network, or other tools. No writes or external actions. If unavailable return UNAVAILABLE. If called, return JSON containing outcome, summary, nonce, logs and remoteStopped exactly from its feedback. Do not invent values.'},skills:[],tools:[],${red ? '' : "mcp:[{service:'readonly',tools:['inspect']}],"}validateReport(output){return {summary:output}}}],
roleBindings:[{role:'report',provider:'cc-switch',environment:'readonly',commit(){return ${JSON.stringify(sha)}}}]
};`);
const relay = createServer(client => {
  if (!/^10\.231\.19\.(?:[2-9]|1[0-4])$/.test(client.remoteAddress ?? '')) {client.destroy();return;}
  const upstream = connect(15721,'127.0.0.1'); client.pipe(upstream); upstream.pipe(client);
  client.on('error',()=>upstream.destroy()); upstream.on('error',()=>client.destroy());
  client.on('close',()=>upstream.destroy()); upstream.on('close',()=>client.destroy());
});
relay.listen(15721,'10.231.19.1'); await once(relay,'listening');
const data = mkdtempSync(join(tmpdir(),'issue-23-data-')); const socket = join(data,'control.sock');
const server = spawn(process.execPath,['--import','tsx','src/cli.ts','serve','--data',data,'--config',config],{cwd:root,stdio:['ignore','ignore','pipe']});
// Do not print config, environment, raw inspect, session or unfiltered model output.
server.stderr.on('data',()=>{});
async function cli(args) {
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts',...args,'--socket',socket],{cwd:root,stdio:['ignore','pipe','pipe']});
  let out=''; child.stdout.on('data',chunk=>out+=chunk); child.stderr.on('data',()=>{});
  const [code]=await once(child,'exit'); assert.equal(code,0,'Public CLI failed'); return JSON.parse(out);
}
let attempt;
let submitted = false;
let exited = false;
try {
  for(let i=0;i<100;i++){try{await cli(['list']);break}catch{assert.equal(server.exitCode,null,'Control service exited');await delay(100)}}
  // Once submit is sent, a missing/invalid receipt cannot prove non-acceptance.
  submitted = true;
  const receipt=await cli(['submit','--repo','fixture','--capability','report','--input','"inspect"','--source','manual']);
  if(receipt.accepted === false) submitted = false;
  assert.equal(receipt.accepted,true);
  for(let i=0;i<300;i++) {
    const detail=await cli(['show',receipt.executionId]); attempt=detail.attempts.at(-1);
    if(attempt?.stopConfirmation?.kind==='agent-exit-marker'){exited=true;break;}
    if(['start_failed','unknown'].includes(detail.execution?.status))throw Error('Real attempt did not produce confirmed agent exit');
    await delay(1000);
  }
  assert.ok(exited,'No confirmed exit within observation window; resources retained, no forced termination');
  assert.equal(attempt.exitCode,0); assert.equal(attempt.error,undefined); assert.equal(attempt.contract,'valid');
  const facility=JSON.parse(docker(['inspect',attempt.container,'--format','{{json .HostConfig.ReadonlyRootfs}}']));
  assert.equal(facility,true);
  const mounts=JSON.parse(docker(['inspect',attempt.container,'--format','{{json .Mounts}}']));
  assert.ok(mounts.length>0 && mounts.every(m=>m.RW===false));
  if(!red)assert.ok(mounts.some(m=>m.Destination==='/orchestrator-mcp/readonly.json' && m.RW===false),'Native MCP config must be mounted readonly');
  assert.equal(git(['status','--porcelain']), '', 'Source fixture must remain unchanged');
  assert.equal(docker(['exec',attempt.container,'git','-C','/home/agent/workspace','rev-parse','HEAD']),sha);
  assert.equal(docker(['inspect',attempt.container,'--format','{{.Config.User}}']),`${process.getuid()}:${process.getgid()}`);
  const processes=docker(['top',attempt.container,'-eo','pid,comm']); assert.ok(!/claude|node/.test(processes),'Agent or MCP process still active');
  let evidence=[];
  try {evidence=docker(['exec',attempt.container,'cat','/tmp/issue-23-mcp-evidence.jsonl']).split('\n').filter(Boolean).map(JSON.parse);} catch { /* Missing service receipt is the red assertion, not success. */ }
  const calls=evidence.filter(e=>e.method==='tools/call');
  const metadata={phase:red?'without-mcp':'with-mcp',executionId:receipt.executionId,attemptId:attempt.id,container:attempt.container,exitCode:attempt.exitCode,actualSha:attempt.actualSha,readonly:true,methods:evidence.map(e=>e.method),calls:calls.length,sessionIds:attempt.iterations?.map(i=>i.sessionId)};
  writeFileSync(join(dir,'evidence.json'),JSON.stringify({...metadata,serviceEvidence:evidence},null,2));
  console.log(JSON.stringify({evidence:join(dir,'evidence.json'),...metadata}));
  assert.equal(calls.length,1,'Expected independent native MCP tools/call receipt');
  assert.ok(evidence.some(e=>e.method==='initialize') && evidence.some(e=>e.method==='tools/list'));
  const feedback=calls[0].feedback;
  const returned=JSON.parse(attempt.output.replace(/^```(?:json)?\s*|\s*```$/g,''));
  assert.deepEqual(returned,feedback,'Model must preserve actual feedback, including unreadable logs and unknown remote stop');
  console.log('PASS: real native MCP feedback and nonce matched independent service receipt');
} catch {
  // An uncaught failure would exit this process and silently tear down its relay.
  process.exitCode = 1;
  console.error('Real MCP acceptance failed; inspect retained local evidence');
} finally {
  let processesAbsent = false;
  if(exited && attempt?.container) {
    try { processesAbsent = !/claude|node/.test(docker(['top',attempt.container,'-eo','pid,comm'])); }
    catch { /* Failed verification is not evidence of process absence. */ }
  }
  if(!submitted || (exited && processesAbsent)) {
    // Only our container, after public exit evidence AND a fresh actual process check.
    if(attempt?.container)docker(['stop',attempt.container]);
    if(server.exitCode === null) {const done=once(server,'exit'); server.kill('SIGTERM'); await done;}
    relay.close();
  } else {
    console.error(`Unconfirmed attempt retained for operator inspection: ${dir}`);
    // Do not kill a running agent or its control/relay to manufacture stop evidence.
  }
}

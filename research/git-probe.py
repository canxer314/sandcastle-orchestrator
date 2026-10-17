import json, os, subprocess, tempfile
from pathlib import Path

root=Path(tempfile.mkdtemp(prefix='issue-114-git-probe-'))
home=root/'empty-home';home.mkdir()
env={'PATH':os.environ['PATH'],'HOME':str(home),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_SYSTEM':'/dev/null','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0','GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1'}
checks=[]
def git(path,*args,ok=True):
    p=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','user.name=Probe','-c','user.email=probe@localhost','-c','commit.gpgSign=false','-C',str(path),*args],env=env,text=True,capture_output=True)
    if ok and p.returncode: raise RuntimeError((args,p.stderr))
    return p

def check(name,condition):
    assert condition,name
    checks.append({'check':name,'passed':True})

source=root/'source';source.mkdir();git(source,'init','-b','main')
(source/'api.txt').write_text('base\n');git(source,'add','.');git(source,'commit','-m','base')
base=git(source,'rev-parse','HEAD').stdout.strip()
remote=root/'published.git';git(root,'clone','--bare','--no-local',str(source),str(remote))
for name in ['configured-repo','agent-a','agent-b']:
    git(root,'clone','--no-local',str(source),str(root/name));git(root/name,'remote','remove','origin')
a=root/'agent-a';b=root/'agent-b';configured=root/'configured-repo'
(a/'api.txt').write_text('task A API\n')
check('uncommitted change in A is absent from B',(b/'api.txt').read_text()=='base\n')
git(a,'add','.');git(a,'commit','-m','agent local result')
a_sha=git(a,'rev-parse','HEAD').stdout.strip()
check('local commit in A is absent from independent B',git(b,'cat-file','-e',a_sha+'^{commit}',ok=False).returncode!=0)

# Model a publisher using only known fixture file bytes, not A's writable .git.
publisher=root/'publisher';git(root,'clone','--no-local',str(source),str(publisher));git(publisher,'remote','remove','origin')
(publisher/'api.txt').write_text((a/'api.txt').read_text());git(publisher,'add','.');git(publisher,'commit','-m','published tested tree')
published_sha=git(publisher,'rev-parse','HEAD').stdout.strip()
git(publisher,'push',str(remote),'HEAD:refs/heads/task-a')
check('publication into remote fixture does not update configured repo',git(configured,'cat-file','-e',published_sha+'^{commit}',ok=False).returncode!=0)
check('publication also does not update already created B',(b/'api.txt').read_text()=='base\n')

prepared=root/'prepared';git(root,'clone','--no-local','--no-checkout',str(remote),str(prepared));git(prepared,'remote','remove','origin')
check('fresh authorized source contains published commit',git(prepared,'rev-parse','--verify',published_sha+'^{commit}').stdout.strip()==published_sha)
missing=root/'clone-of-unreferenced-source';git(root,'clone','--no-local','--no-checkout',str(prepared),str(missing))
check('object existing only without an advertised head is not guaranteed in next clone',git(missing,'cat-file','-e',published_sha+'^{commit}',ok=False).returncode!=0)
# Keep a trusted named source ref before applying the current clone-based role setup.
git(prepared,'update-ref','refs/heads/task-input-a',published_sha)
downstream=root/'downstream';git(root,'clone','--no-local','--no-checkout',str(prepared),str(downstream));git(downstream,'remote','remove','origin');git(downstream,'checkout','--detach',published_sha)
check('independent downstream reads exact published result without worktree sharing',(downstream/'api.txt').read_text()=='task A API\n')
check('downstream has independent git directory',(downstream/'.git').is_dir() and not (downstream/'.git/objects/info/alternates').exists())
tree=git(publisher,'rev-parse','HEAD^{tree}').stdout.strip()
check('tree identifier cannot be supplied as commit SHA',git(publisher,'rev-parse','--verify',tree+'^{commit}',ok=False).returncode!=0)

sibling=root/'sibling';git(root,'clone','--no-local',str(source),str(sibling));(sibling/'other.txt').write_text('task C result\n');git(sibling,'add','.');git(sibling,'commit','-m','parallel predecessor')
check('choosing one predecessor commit does not combine another predecessor result',not (downstream/'other.txt').exists())
result={'scope':'Synthetic local Git probe only; no Docker, model, credential or external remote operation; not application acceptance','git_version':git(root,'--version').stdout.strip(),'directory':str(root),'base_sha':base,'agent_sha':a_sha,'published_sha':published_sha,'published_tree':tree,'checks':checks}
Path(__file__).with_name('git-probe-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))

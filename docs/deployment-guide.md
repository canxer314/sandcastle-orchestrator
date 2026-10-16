# Sandcastle 部署与运维指南

本指南面向部署管理员，保留从本地练习、接入仓库、配置 Agent/工具到故障恢复的操作细节。普通使用者请先看[用户指南](user-guide.md)；配置与远端写入须由管理员按授权范围完成。

> 下文是管理员从源码部署的高级流程。普通安装用户从[正式安装](installation.md)及 [init/doctor/demo](onboarding.md)开始，无需 pnpm。正式渠道验收见[发布记录](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-86-release-acceptance.md)。

> 本指南对应当前 checkout 的 CLI。需要 Linux、Node.js 24+、pnpm 12.3.4、Git、util-linux `flock`；执行 capability 还需要 Docker daemon。示例明确使用可信官方基础镜像 `node:22.22-alpine`，由你自行执行 `docker pull`，不是 Sandcastle 自动下载；它适合本示例的 `/bin/sh`、`grep` 测试脚本，不代表适合真实业务或已包含项目依赖。容器使用 `--pull=never`、`--network none`，不联网安装容器依赖。

## 1. 做一个本地 test-commit

### 1.1 准备四个互不包含的目录

以下命令把新 clone 放在 `$HOME/sandcastle-orchestrator`；数据、配置和练习 Git repo 与应用分开，互不包含。

```sh
set -eu
export APP="$HOME/sandcastle-orchestrator"
export CONFIG_DIR="$HOME/sandcastle-demo-config"
export DATA="$HOME/sandcastle-demo-data"
export REPO="$HOME/sandcastle-demo-repo"

git clone https://github.com/canxer314/sandcastle-orchestrator.git "$APP"
cd "$APP"
pnpm install --frozen-lockfile
mkdir -m 700 "$CONFIG_DIR" "$DATA" "$REPO"
# 建议将镜像固定到组织审查并批准的 digest；此公共基础镜像仅为本地教程示例。
docker pull node:22.22-alpine
docker image inspect node:22.22-alpine >/dev/null
command -v node; node --version
command -v pnpm; pnpm --version
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
test "$(pnpm --version)" = '12.3.4'
command -v git; git --version
command -v flock
command -v docker; docker info >/dev/null
```

Node 必须是 24 或更高，pnpm 必须是 12.3.4。镜像 `docker pull` 是用户明确执行的联网步骤；pull 后 inspect 确认本地镜像。练习 repo、配置、应用和数据目录都位于 home 下独立路径。真实业务请先审查并固定可信镜像；容器不会联网拉取镜像或安装依赖。

### 1.2 建立带测试脚本的练习仓库

```sh
cat > "$REPO/test.sh" <<'EOF'
#!/bin/sh
set -eu
test -f README.txt
grep -qx 'hello from test-commit' README.txt
printf '%s\n' 'test passed'
EOF
printf '%s\n' 'hello from test-commit' > "$REPO/README.txt"
chmod +x "$REPO/test.sh"
git -C "$REPO" init
git -C "$REPO" add test.sh README.txt
# 只为这个练习 repo 设置身份，不修改全局 Git 配置。
git -C "$REPO" -c user.name='Sandcastle Demo' -c user.email='demo@example.invalid' commit -m 'Add local test script'
export COMMIT="$(git -C "$REPO" rev-parse HEAD)"
test "${#COMMIT}" -eq 40
printf '练习 commit: %s\n' "$COMMIT"
```

后面提交的是这一个完整 40 位 SHA。不要用分支名、短 SHA 或 Docker 镜像版本代替任务 commit。

### 1.3 写可信配置

配置是管理员部署并执行的可信 TypeScript 代码，不是任务输入。下面使用 `$APP` 绝对路径的 type-only import 和前一步已拉取的练习镜像。教程没有配置仓库，因此示例 `version: 'demo-v1'` 只是明确的本地演示标签，不冒充 Git commit；实际部署请记录配置仓库的真实 commit。

```sh
cat > "$CONFIG_DIR/config.ts" <<EOF
import type { Configuration } from '$APP/src/config.js';

export default {
  version: 'demo-v1',
  repos: [{ id: 'demo', location: '$REPO' }],
  environments: [{ id: 'test-only', docker: { image: 'node:22.22-alpine' } }],
  capabilities: [{
    id: 'test-commit',
    environment: 'test-only',
    validate(input: unknown) {
      if (typeof input !== 'string' || !/^[a-f0-9]{40}$/.test(input)) {
        throw new Error('Expected a full commit SHA');
      }
    },
    execution: { commit(input: unknown) { return input as string; } },
    async run(context) {
      const result = await context.exec(['sh', '/workspace/test.sh']);
      return { business: { passed: result.exitCode === 0, exitCode: result.exitCode } };
    },
  }],
} satisfies Configuration;
EOF
```

`examples/config.ts` 是同一 capability 的最小示例。配置验证器要求完整 SHA，selector 固定到同一个输入；测试返回值放在 `business`，测试脚本退出非零也会作为业务结果记录，而不是自动等于 CLI/contract 错误。教程使用的 `demo-v1` 只是本地标签，不是 commit；实际部署请将 `version` 设为配置仓库的真实 commit。启动前确认 `$REPO`、配置文件和 `$DATA` 均分离。

### 1.4 终端 A 启动服务

在终端 A 设置同样的路径变量（新终端不会继承上一段 shell 的局部变量），然后启动：

```sh
export APP="$HOME/sandcastle-orchestrator"
export CONFIG_DIR="$HOME/sandcastle-demo-config"
export DATA="$HOME/sandcastle-demo-data"
export REPO="$HOME/sandcastle-demo-repo"
cd "$APP"
pnpm start serve --data "$DATA" --config "$CONFIG_DIR/config.ts"
```

前台保持运行。就绪时输出 JSON，含 `"ready":true` 和 socket 路径。服务会独占数据目录锁；`flock` 不可用或目录与配置/checkout 不分离时应先解决启动错误，不要删除 lock 文件绕过。

### 1.5 终端 B 提交、查询、看日志

另开终端 B，重新设置变量。`pnpm exec tsx src/cli.ts` 直接执行 CLI，不经 `pnpm start` 的脚本 banner；回执为纯 JSON。下面要求 `jq`，先检查依赖，再验证接纳状态并自动保存两个 ID：

```sh
command -v jq >/dev/null || { echo '请先安装 jq' >&2; exit 1; }
export APP="$HOME/sandcastle-orchestrator"
export DATA="$HOME/sandcastle-demo-data"
export REPO="$HOME/sandcastle-demo-repo"
cd "$APP"
COMMIT="$(git -C "$REPO" rev-parse HEAD)"
REPLY="$(pnpm exec tsx src/cli.ts submit --socket "$DATA/control.sock" \
  --repo demo --capability test-commit --source manual \
  --input "\"$COMMIT\"")"
printf '%s\n' "$REPLY" | jq -e '.accepted == true and (.requestId | type == "string") and (.executionId | type == "string")' >/dev/null || {
  echo '提交未接纳；检查回执中的 reason 或 requestId' >&2
  exit 1
}
REQUEST_ID="$(printf '%s\n' "$REPLY" | jq -r .requestId)"
EXECUTION_ID="$(printf '%s\n' "$REPLY" | jq -r .executionId)"
printf 'requestId=%s\nexecutionId=%s\n' "$REQUEST_ID" "$EXECUTION_ID"
```



```sh
pnpm exec tsx src/cli.ts show "$REQUEST_ID" --socket "$DATA/control.sock"
pnpm exec tsx src/cli.ts show "$EXECUTION_ID" --socket "$DATA/control.sock"
pnpm exec tsx src/cli.ts logs "$EXECUTION_ID" --socket "$DATA/control.sock"
```

实际 `show` 是对象结构。常用路径为 `.execution.status`、`.attempts[-1].contract`、`.attempts[-1].business.passed` 和 `.attempts[-1].business.exitCode`；ID 也可通过 `.request.id` 与 `.execution.id` 核对。成功示意（ID/时间为例，不是实际运行输出）：

```json
{
  "request": { "id": "<requestId>" },
  "execution": { "id": "<executionId>", "status": "completed" },
  "attempts": [{
    "contract": "valid",
    "business": { "passed": true, "exitCode": 0 }
  }]
}
```

`completed` 仅表示入口结束已保存，不等于测试成功；要同时看 `contract` 与 `business`。`logs` 查看 stdout/stderr。失败测试用新的完整 SHA 演练，不能改写已经提交的 commit：

```sh
cd "$REPO"
printf '%s\n' 'hello from test-commit' > README.txt
printf '%s\n' '#!/bin/sh' 'set -eu' 'exit 1' > test.sh
chmod +x test.sh
git add README.txt test.sh
git -c user.name='Sandcastle Demo' -c user.email='demo@example.invalid' commit -m 'Make demo test fail'
FAILED_COMMIT="$(git rev-parse HEAD)"
test "${#FAILED_COMMIT}" -eq 40
cd "$APP"
REPLY="$(pnpm exec tsx src/cli.ts submit --socket "$DATA/control.sock" \
  --repo demo --capability test-commit --source manual \
  --input "\"$FAILED_COMMIT\"")"
printf '%s\n' "$REPLY" | jq -e '.accepted == true' >/dev/null || { echo 'failure test submission rejected' >&2; exit 1; }
FAILED_ID="$(printf '%s\n' "$REPLY" | jq -r .executionId)"
pnpm exec tsx src/cli.ts show "$FAILED_ID" --socket "$DATA/control.sock"
```

失败尝试预期仍可能是 `completed`、`contract: valid`，但 `business.passed` 为 `false`、`exitCode` 非零。练习后若要恢复成功脚本，修改文件并另建恢复 commit；之后提交新 SHA。

停服务前先停止新接纳和新启动。在终端 B 执行维护暂停，再确认所有执行都已可信结束；有 `running`、`starting`、`unknown` 或未决工具调用时，不要退出终端 A，应先按第 5 节核查。暂停不停止已有任务。

```sh
pnpm exec tsx src/cli.ts pause --socket "$DATA/control.sock" --target all \
  --source operator --reason '本地练习结束前暂停'
pnpm exec tsx src/cli.ts list --socket "$DATA/control.sock" --repo demo
# 对每个 executionId 执行 show；确认没有运行中/未决 attempt 后，才可在终端 A 按 Ctrl-C。
```

Ctrl-C 仅请求控制服务退出，不是停止任务的手段，也不证明 harness/container 已停。若本地练习仍有执行，先等可信结束或按恢复流程处理；不要强杀进程或容器。


## 2. 接入真实 Git 仓库

1. 先确认授权范围和本地 checkout。`repos[].location` 必须是本机 Git checkout；checkout、配置目錄和专用 `$DATA` 不要相互包含。确保服务运行用户只得到预期的 repo 读权限。
2. 在受信配置的 `repos` 登记稳定 ID 与绝对 checkout 路径；为该 repo 添加实际要用的 capability/environment。配置 `version` 记部署配置版本，不填任务 SHA。
3. 先用完整 commit SHA 手工 submit。编排器会从本地 repo 导出该 commit 的内容；它不会替你 fetch，也不会带入未提交更改、remote、`.git` 或 hooks。当前拒绝 symlink/submodule，且单个 blob 上限 64 MiB。先确认 SHA 在本地对象库中存在。
4. 执行 capability 使用预先部署的可信镜像，不能把仓库里的任意脚本或依赖安装当成可信。Docker 执行无网络、`--pull=never`、只挂载尝试代码及产物，镜像不会自动清洗；管理员负责镜像来源、UID/GID 兼容和其中依赖。没有真实 Docker 授权时只跑受控测试，不要以测试替身冒充容器验收。

## 3. 最小只读 Agent 配置

只读角色需要已有、明确授权的 `AgentProvider` 和能在容器内工作的镜像。不要照抄不存在的 provider、模型 ID、认证变量或镜像名。Sandcastle 的公开类型要求 provider 的 `agent` 实现 `AgentProvider`；代码结构见 `src/config.ts` 的 `Configuration.providers/roleBindings`，Agent 通过 `src/agent.ts` 的公开 provider seam 调用。认证和模型路由必须按你部署的 provider 文档配置，只使用专用授权凭据；不要把宿主环境或 Git 写凭据灌入容器。

在现有配置中添加角色及绑定（保留现有 `repos`、capabilities 等）。`buildPrompt` 的签名来自本项目 `Role`：`{input: unknown; repo: string; actualSha: string}`，其中 `repo` 是登记 repo 的 ID。Sandcastle 的 provider 可从依赖公开入口导入 `claudeCode`，构造时 model 字符串由管理员按已授权部署提供；不要虚构默认模型或认证变量。以下片段是合并进现有 `Configuration` 的示意，provider 行是实际可用构造，运行仍须由你自己的授权配置提供模型映射/认证。

```ts
import { claudeCode } from '@ai-hero/sandcastle';
import type { Configuration, Role } from '/absolute/path/to/app/src/config.js';

const readOnlyRole: Role = {
  id: 'read-report',
  description: '只读检查固定版本并返回报告',
  validate(input) {
    if (!input || typeof input !== 'object' || !('sha' in input)
      || typeof input.sha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sha)) {
      throw new Error('Expected { sha: full commit SHA }');
    }
  },
  buildPrompt({ repo, actualSha }) {
    return `只读检查登记仓库 ${repo}，固定版本 ${actualSha}。不要修改仓库或发布外部副作用；报告证据与限制。`;
  },
  skills: [],
  tools: [],
  validateReport(output) { return output; },
};

const config = {
  // 保留并合入已有 repos/capabilities；仅列本角色必需增量。
  version: '填写配置部署版本',
  repos: [{ id: 'approved-repo', location: '/srv/repos/approved-repo' }],
  environments: [{ id: 'agent-readonly', docker: { image: 'YOUR_PREPULLED_TRUSTED_IMAGE', network: 'none' } }],
  capabilities: [],
  roles: [readOnlyRole],
  providers: [{ id: 'authorized-claude', agent: claudeCode(process.env.APPROVED_MODEL!) }],
  roleBindings: [{
    role: 'read-report', provider: 'authorized-claude', environment: 'agent-readonly',
    commit(input) { return (input as { sha: string }).sha; },
  }],
} satisfies Configuration;

export default config;
```

把 `/absolute/path/to/app`、repo 路径、可信镜像和 `APPROVED_MODEL` 映射替换为管理员部署的实际值；模型参数不是认证本身。上例环境 `none` 仅适用于离线 provider。若真实 Claude Code provider 需要 endpoint 网络，必须由管理员另行授权并在外部实施仅允许模型 endpoint 的 egress，不能简单改成 unrestricted bridge。只读角色默认不挂载宿主 home、原 checkout 写权限、Docker socket或 Git 写凭据。先在授权环境验收挂载、模型调用、报告及日志；配置加载器会核验角色、provider、Docker environment 和 SHA selector。

提交形式例如：

```sh
pnpm exec tsx src/cli.ts submit --socket "$DATA/control.sock" --repo approved-repo \
  --capability read-report --source manual \
  --input '{"sha":"替换为本地存在的40位完整SHA"}'
```

实际使用时将占位文本替换为真实 40 位 SHA；JSON 属性值须是字符串。也可复用第 1.5 节的 `jq` 检查和 ID 提取方式。

## 4. implementation 与 PR analysis

这两者是管理员配置的能力组合，不是多写一个 capability 名称就能工作。先读 `examples/implementation.ts`、`examples/pr-analysis.ts` 以及下方高级配置参考，按部署约束把增量合入可信配置。

### implementation：测试后发布 Draft PR

- 先配置一个现有 readonly `test-commit` capability、可执行的 `run_tests` 工具及明确的 `inputSchema`；`examples/implementation.ts` 使用空对象 schema，要求该测试 capability 接受 `{}`。
- 配置 `implementation` role，并在其 `tools` 中引用 `run_tests` 与 `publish_draft`；`providers` 必须使用实际授权的 Claude Code provider 并显式启用 `mcp: 'claude-code'`。配置 `roleBindings` 时设置 `workspace: 'implementation'`，其余老角色保持默认 readonly。
- `publish_draft` 必须是 `{id:'publish_draft', description:'...', publication:true}` 工具。仅当已授权写 GitHub 时才设置 repo 的 publication target；值必须是管理员批准的 owner/repo、匹配的 HTTPS remote、base branch 和专用写凭据来源。禁止把凭据写入配置快照、输入或 Prompt。示例注释里的 env 变量只是形状提示，不能照抄成已配置认证。
- 确认发布目标 repo、匹配的 HTTPS remote、base branch 与专用 GitHub 写凭据已由部署者配置并授权；模型和测试容器不接触写凭据。
- 确认发布结果未知时只查询原 `callId`，不重复写；实际 Draft PR 需人工审查，不会自动 merge。
- 将以下事项逐项核验后才交付给使用者：
  - [ ] 已登记目标 GitHub 仓库及本地 checkout，配置中的 publication 目标与 repo/base 完全匹配。
  - [ ] `implementation` role、Claude Code MCP provider、`workspace: 'implementation'` 和 `run_tests` 只读测试能力均已实际配置并验收。
  - [ ] `publish_draft` 与专用 Git/GitHub 写凭据已配置在宿主 writer 环境；授权范围仅覆盖目标 repo，模型及测试环境不可见。
  - [ ] Docker/provider/网络和固定基线 commit 均可用；基线完整 SHA 在登记 checkout 的本地对象库中可访问。
  - [ ] 已向使用者交付 APP 绝对路径、DATA/socket 位置、登记 repo ID，以及该能力已配置并获准发布 Draft PR 的说明。

### pr-analysis：分析管理员提供的 PR 快照

- 依 `examples/pr-analysis.ts` 配置 `createPrAnalysisRole(scope)` 与 `createPrSnapshotTool({...scope,path})`。把 repo/PR 白名单设成确实获准的值，快照路径指向管理员准备的只读普通文件。
- 快照由管理员离线提供，工具不联网采集或独立核验 GitHub；结果会明确 `verifiedAgainstGitHub:false`。PR 的 head SHA 是快照描述，不代表本地 checkout SHA。不要把 PR 分析当作测试通过或 GitHub 当前状态。
- 使用独立受控 provider 和已预拉取镜像。`network: 'none'` 仅适用于离线 provider；真实模型必须有单独授权与外部 endpoint-only 网络控制，不能开放任意网络。不要加入 GitHub 写凭据。
- 提交输入按示例提供 `sha`、白名单内 `pullRequests` 编号和分析 `question`。保存回执 ID 后用 `show`、`artifact --name observations.jsonl` 与 `artifact --name report.txt` 核对证据；大文件按 CLI 支持的 offset 分块读取。

## 5. 日常取消、重试与恢复

先用 `list --status` 找到执行，再 `show` 检查当前 attempt、状态、`actualSha`、日志、容器名、工具调用和外部副作用。管理 CLI 参数以当前 parser 为准：`cancel` 需要 `--reason`；`confirm-stop`/`resolve`/`retry` 需要 `--source`、`--handling`、`--reason`；`resolve`/`retry` 还必须有 `--external-results`。处理说明必须写实际核对结果，不要填模板文字冒充证据。

```sh
pnpm start list --socket "$DATA/control.sock" --repo approved-repo --status unknown
pnpm start show "$EXECUTION_ID" --socket "$DATA/control.sock"
pnpm start logs "$EXECUTION_ID" --socket "$DATA/control.sock" --attempt "$ATTEMPT_ID"
pnpm start cancel "$EXECUTION_ID" --socket "$DATA/control.sock" --reason '说明取消原因'
```

取消只提出协作停止请求，不证明容器、Agent、子进程或远端工作已经停止。先按 `show` 中容器定位到实际 daemon，检查 `docker inspect` 的真实状态、入口及工具执行、服务日志和外部系统结果；缺证据就让它保持 `unknown`，不要 retry。**不要在未独立核查前运行 `confirm-stop`，也不要 kill harness、控制进程或容器来制造停止结论。**

确认所有相关执行确已停止后，人工记录核查依据：

```sh
pnpm start confirm-stop "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写实际停止核查方式和证据' \
  --reason '填写确认原因'
```

`confirm-stop` 只是记录操作者确认，不替代核查，也不自动结束 unknown。核对旧外部副作用后，才可以二选一：

```sh
pnpm start resolve "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写已完成的核对和处理' --reason '说明为何结束未决状态' \
  --external-results '填写实际外部结果及证据'

pnpm start retry "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写已完成的核对和处理' --reason '说明再次执行理由' \
  --external-results '填写实际外部结果及证据'
```

`retry` 会建立新 attempt，不复用旧日志或目录；若需求或基线变了，提交新请求而非 retry。清理只通过管理入口，且须满足保留条件；不要用 `docker rm -f`、`docker prune` 或批量删除替代核查。

进一步的提交字段、状态含义、备份恢复、日志/产物限制见下方参考；旧管理命令默认输出 JSON，显式 `--human` 提供可读结果；init/doctor/demo/setup 默认可读，支持 `--json`。退出码和不确定回执见[提交指南](submissions.md)，不能仅看退出码判断受理或业务成功。妥善保护输入、配置、报告和日志，其中可能包含敏感数据。


# 配置、运维与开发参考

以下完整保留原 README 的高级参考，供管理员按需查阅，不是首次分析的前置知识。源码开发用 pnpm；已安装用户将 `pnpm start` 换为 `sandcastle-orchestrator`。

## 开发与高级配置

开发源码使用 pnpm 12.3.4。Sandcastle 固定为 `0.12.0`，Effect 固定为 `3.20.0`，升级需显式更新依赖和锁文件。以下开发入口保留：

```sh
pnpm install --frozen-lockfile
pnpm start serve --data /srv/orchestrator-data --config ./examples/config.ts
```

先修改配置中的 repo 登记和能力定义。配置是管理员部署的可信 TypeScript 代码，启动时加载，不热更新。`version` 填配置仓库的部署 commit，不是任务代码 SHA。输入校验器可以同步或异步执行，以抛出错误或 Promise 拒绝表示拒绝；服务等待校验结束后才保存接纳记录。服务在校验前保存原始输入快照，校验器的返回值或原地修改均不改写接纳或拒绝记录中的输入。旧配置仍有效，没有 `execution` 的能力只接纳排队，不调用 `run`。明确配置 `execution.commit(input)` 和对应环境的 `docker.image` 后，只有新提交或显式 retry 自动执行；历史确定性排队请求不因重启或后来启用执行配置而自动启动。不完整执行配置拒绝启动服务。示例能力要求完整 SHA，业务脚本为目标 commit 中的 `test.sh`。

运行目录必须专供本应用使用，与配置及目标 checkout 分开，不提交到 Git。启动前检查应用、配置目录和登记的 checkout 路径，拒绝包含关系及符号链接重合，检查失败不修改目录权限。repo 位置当前是本地 checkout 路径。服务将目录权限设为 `0700`，socket 和新建文件设为 `0600`。同一目录只能启动一个控制实例，内核文件锁在服务崩溃后释放。无需也不得通过删除锁文件恢复。

## 维护窗口、备份与恢复

安装、卸载和换版的资源保留及手工操作步骤见[安装说明](installation.md#资源保留与手工换版)。包管理器不能发现所有服务实例，也不会替你暂停或停止服务。

管理入口新增 `maintenance` 查询，`pause`／`resume --target admission|starts|all`（默认 all），均要求 `--source`、`--reason`。暂停状态及操作历史保存在 SQLite，重启不自动恢复。`serve --maintenance paused` 在首次 dispatch 前暂停接纳与启动；恢复旧备份必须使用 `serve --maintenance restore`，每次建立新的核对门槛。暂停启动不暂停或 kill 已有 attempt，也不表示它已停止。查询、协作取消和人工核对仍可用；优先等待 `list/show` 中执行可信结束，不能等时用现有 `cancel`、`confirm-stop`、`resolve`，未确认停止仍为 unknown，不释放额度、不替代执行。不要关闭 harness 或容器制造结束。

```sh
pnpm start pause --socket "$DATA/control.sock" --target all --source operator --reason 'pre-upgrade backup'
pnpm start maintenance --socket "$DATA/control.sock"
pnpm start list --socket "$DATA/control.sock"
```

人工确认没有运行中或未确认的外部执行后，停止控制服务（只发 SIGTERM 给控制进程，不发给 harness），用主机工具做一致的离线备份。不能只复制在线 SQLite 主文件；若无法静止全部写入，使用 SQLite `.backup` 获得数据库快照，但日志和产物仍需单独保证一致。暂停不冻结日志，备份时不要运行 cleanup。下面是离线备份示例，`DATA`、`CONFIG_DIR`、`BACKUP` 是管理员指定、互不包含的绝对目录；配置依赖文件也应位于 CONFIG_DIR。凭据保留现有主机 secret 管理，不把环境、token、连接串写入记录或示例备份。备份目录应在独立磁盘或现有受保护的异机备份系统，示例临时磁盘不是灾备。

```sh
set -eu
umask 077
mkdir -m 700 "$BACKUP"
date -u +%FT%TZ > "$BACKUP/backup-point.txt"
sqlite3 "$DATA/records.sqlite" ".backup '$BACKUP/records.sqlite'"
test "$(sqlite3 "$BACKUP/records.sqlite" 'PRAGMA integrity_check;')" = ok
tar --exclude=control.sock --exclude=control.lock --exclude=records.sqlite --exclude=records.sqlite-wal --exclude=records.sqlite-shm -C "$DATA" -cpf "$BACKUP/evidence.tar" .
tar -C "$CONFIG_DIR" -cpf "$BACKUP/config.tar" .
date -u +%FT%TZ > "$BACKUP/backup-completed.txt"
# 保存应用 commit、Node/pnpm 版本和配置 version；独立保存备份开始之后的主机/远端写入审计。
```

备份和恢复命令遇到错误立即停止。`BACKUP` 必须是尚不存在的新目录，其父目录须已存在且由管理员保护。`backup-point.txt` 是备份开始时间，也是外部审计核对下界；`backup-completed.txt` 只记录备份完成时间，不用它筛选副作用。跨主机核对还须考虑时钟偏差，保留开始时间之前的必要余量。

实际频率由主机备份任务配置并记录，例如每日 02:00 UTC 加每次升级前；必须按维护窗口暂停、等待和离线一致性要求执行，不能把该示例当作已部署 timer。保留期、加密、异机复制和告警沿用现有主机工具。磁盘损坏最多恢复到可用备份点，不承诺零丢失或无人介入的恢复时间。

升级前保存上述完整备份及旧应用/配置版本；在暂停状态升级依赖/应用，先 typecheck/tests，再启动 `--maintenance paused`，检查 configuration 可加载、`list/show/logs/artifact` 可读并核对已有状态，再明确 resume。本版本新增独立 maintenance 和确定性启动授权表，不修改旧记录和配置格式，旧 socket 命令保持有效。暂停期间明确提交或 retry 的确定性任务会保留启动授权，暂停状态在正常重启后仍保持，须明确 resume 才启动；没有执行配置时接纳的历史 queue 不获得授权，后来启用执行配置也不自动启动。restore 启动原子清除旧备份中的确定性启动授权，核对后不会把这些陈旧 queue 当作新提交执行。旧程序不会执行 maintenance gate，不能用于带待核对备份的正常启动；回退时停服务、恢复匹配的旧备份与配置、核对外部副作用后才启动旧程序。未来格式变化必须单独说明兼容和恢复方案，不能假定旧程序可读新数据；本应用不建设自动迁移/回滚平台，不删除现有迁移和 rollback。

恢复到新建隔离目录，保留故障现场和备份之后的独立审计；不覆盖仍在使用的 data、不复制 socket/lock。两个恢复目录必须尚不存在，父目录须已存在且由管理员保护；解包后核验配置和证据文件权限，根目录保持 `0700`，不要把恢复目录放在共享目录中。恢复配置目录与产物，验证数据库 integrity_check，然后以 restore 模式启动，在任何新执行前核对备份之后的执行、子 Agent、工具、容器及远端写入（数据库缺失的执行也要靠主机/远端审计找回），取消不再适用的旧排队请求，必要时人工确认停止／resolve。不确定就保持暂停。

```sh
set -eu
umask 077
mkdir -m 700 "$RESTORED_DATA" "$RESTORED_CONFIG"
cp "$BACKUP/records.sqlite" "$RESTORED_DATA/records.sqlite"
tar -C "$RESTORED_DATA" -xpf "$BACKUP/evidence.tar"
tar -C "$RESTORED_CONFIG" -xpf "$BACKUP/config.tar"
chmod 700 "$RESTORED_DATA" "$RESTORED_CONFIG"
test "$(sqlite3 "$RESTORED_DATA/records.sqlite" 'PRAGMA integrity_check;')" = ok
pnpm start serve --data "$RESTORED_DATA" --config "$RESTORED_CONFIG/config.ts" --maintenance restore
# 在另一个终端检查 list/show/logs/artifact、配置版本和独立外部审计。
pnpm start restore-review --socket "$RESTORED_DATA/control.sock" --source operator \
  --reason 'post-backup audit compared' --backup-point "$(cat "$BACKUP/backup-point.txt")" \
  --handling 'stale queue cancelled; unknown executions reconciled' --external-results 'host and remote audit checked; describe actual results'
pnpm start resume --socket "$RESTORED_DATA/control.sock" --source operator --reason 'review accepted'
```

`restore-review` 要求接纳和启动都暂停，要求 backup-point、handling、external-results 非空；它保存人工核对，不验证操作者描述的真实性，也不自动 resume。未记录核对前拒绝 resume。恢复无法自动检测，操作者必须使用 restore 启动模式。核对后排队 Agent 在显式恢复时按现有 quota 启动，操作者须先取消不再适用的队列。无启动授权的历史确定性 queue 保持原有不自动执行规则；queued 状态不能 retry，需要先取消并核对副作用，再明确 retry。每次演练记录实际频率配置、快照时间、恢复耗时、验证项和介入条件；真实模型/容器与部署验收另行授权。

实际受控本地演练（2026-10-11）：频率配置为手动按需、每次受控升级前，无生产 timer。备份点 `2026-10-11T12:51:50.228Z`；从复制 SQLite／解包 config 与产物，到服务 restore 启动、管理入口读取记录／logs／report.txt、拒绝提前恢复、取消陈旧 queue、记录核对并恢复共 576 ms（临时本地数据，不是 RTO 承诺）。使用真实 `sqlite3 .backup`、`integrity_check`、`tar`，Agent／Docker 由受控替身提供；人工介入包括暂停、等待已有执行结束、离线备份恢复、核对证据与外部副作用说明、取消 queue 和明确 resume。未验证真实模型、真实容器、生产部署、定时任务、异机复制、磁盘损坏或大数据恢复耗时。可复跑 `pnpm test tests/quota.test.ts -t 'external SQLite' --disableConsoleIntercept --reporter=verbose`；临时目录在演练后删除。

新增备份后本地写入演练验证旧快照缺失执行、独立主机审计、取消陈旧 queue 后明确恢复及不重复写入；另验证维护中协作取消不冒充停止确认。实测备份开始点 `2026-10-11T16:11:31.894Z`，恢复与人工核对流程共 645 ms，仍使用受控执行适配器。复跑 `pnpm exec vitest run tests/maintenance-restore.test.ts --disableConsoleIntercept --reporter=verbose`，范围和限制见[本地主机验收记录](issue-27-local-acceptance.md)。

## 提交与查询

管理命令默认输出原 JSON，不按 TTY 切换。查询和管理写命令都可显式 `--human` 查看可读回执，与 `--json` 互斥。在线查询及使用新模式/选项的写命令未指定 socket 时取所选 `--data` 内的 `control.sock`，默认 data 为 `~/.sandcastle-orchestrator/data`，不加载配置猜路径。旧写调用仍要求 `--socket`。显式 `--offline` 仅用于 show/list/logs，真正只读现有记录且不启动服务。详见[提交与可靠回执](submissions.md)及[查询与离线查证](queries.md)。

```sh
pnpm start submit --socket /srv/orchestrator-data/control.sock \
  --repo example --capability test-commit --input '"0123456789012345678901234567890123456789"' --source manual

pnpm start list --socket /srv/orchestrator-data/control.sock --repo example --status queued
pnpm start show REQUEST_OR_EXECUTION_ID --socket /srv/orchestrator-data/control.sock
```

`--input` 是 JSON，自由文本用 JSON 字符串提交。也可用 `--input-file PATH` 读取文件，或 `--input-file -` 读取 stdin，不能与 `--input` 同用；只解析 JSON，不执行内容。repo 是配置中的 ID，不是 checkout 路径；capability 也可选择 role ID，两者与 source 都必须明确提供。`--source` 是来源标识，如 `manual` 或外部定时脚本名称，不是认证身份，不能放凭据。

`submit --human` 仍是异步接纳，不代表执行成功。未给 key 时在发送前生成并向 stderr 输出 source、key 和同实例的只读核对命令；显式 key 原样使用，JSON 不自动补 key。human 写调用最多等待 30 秒，成功回执退出 0，拒绝/普通错误退出 1，已发出但回执未确认退出 2。Ctrl+C 只停止客户端等待，已发出的不确定写仍为 2，不自动 cancel、重发或启动 serve。cancel 回执不是停止证明。

直接调用 socket 时，提交必须包含 `input` 字段。缺少该字段是协议错误，服务返回 HTTP 400 和 `Missing input`，不建立请求或执行。`repo`、`capability`、`source` 必须是非空字符串，否则返回 HTTP 400 和 `Invalid repo`、`Invalid capability` 或 `Invalid source`，不建立记录。格式正确但未登记的 repo 或能力仍按普通提交规则保存拒绝原因。显式 JSON `null` 不是缺失字段，会交给能力校验器，并按普通提交规则保存结果。未知命令返回 HTTP 400 和 `Unknown command`，不会按 `show` 查询记录。

合法提交在同一个 SQLite 事务中保存请求和执行，返回 `accepted: true`、`requestId`、`executionId`。无效 repo、能力或输入在数据库可写时保存拒绝记录，返回 `accepted: false`、`requestId`、`reason`，不建立执行。校验器抛错即拒绝，即使错误消息为空，也不会建立执行。拒绝也是已记录的提交响应，JSON 退出码为 0，脚本必须检查 `accepted`；human 拒绝退出 1。必要保存失败返回非零退出码，不返回接纳或拒绝回执。

`show` 可使用请求或执行标识，包含原始输入、来源、计划时间 `scheduledAt`、去重键 `deduplicationKey`、拒绝原因、执行状态和尝试列表。`list` 只列执行，按提交顺序返回，可按 repo、状态和 `--source` 筛选。没有执行配置的旧能力或未绑定角色保持排队。启动时按当前配置扫描历史 `queued` 主 Agent 请求，已绑定角色参与调度；历史确定性请求保持排队，旧的未知尝试不自动重跑。原请求/执行表保留，旧提交、查询协议和回执字段保持兼容。

提交可选 `--deduplication-key KEY` 和 `--scheduled-at 2026-10-11T00:00:00Z`；socket 字段为 `deduplicationKey`、`scheduledAt`。键必须是非空字符串，计划时间必须是带时区的 ISO 时间字符串，畸形字段返回 HTTP 400，不建立记录。同一 `source` 内，同键且 repo、capability、原始 JSON 输入、计划时间相同，返回原有接纳回执；JSON 对象字段顺序不影响比较，数组顺序有意义，计划时间按原字符串比较。不同内容返回 HTTP 400 和 `Deduplication key conflict`，CLI 非零退出，不覆盖旧记录。不同来源互不合并，无键每次新建。去重只登记成功接纳的请求；拒绝记录保留键线索，但不占键。接纳、执行和键登记在同一 SQLite 事务中完成。

旧 CLI/socket 提交无需更改；旧 SQLite 表与记录保留，启动时只新增元数据和去重旁表，历史记录的两个新字段为 `null`。停服务并备份数据库后升级；不能据此推断任意旧程序都能读新版数据。旧程序若不支持去重，不能在回退期间继续投递需要去重的任务；重新升级也不能为回退期间的请求追补键。换版、兼容范围及回退步骤见[安装说明](installation.md#资源保留与手工换版)。

外部脚本、cron/systemd timer 配置及补跑边界见 [外部定时提交](external-submission.md)。编排器不重建未收到的触发，不阻止排队重叠，请求去重不保证副作用幂等。

不要在输入或配置里写凭据。服务不主动保存环境变量或认证头，但原始输入和校验错误会持久化，输入、配置和运行记录应当作为敏感数据保护。这不是通用秘密过滤器。

## 确定性执行

管理员能力 `run(context)` 直接使用 `context.exec(argv)` 调用容器脚本，不需要 Agent、模型或 MCP。业务判断留在能力内，返回 `{ business: 任意可 JSON 保存的值, artifacts?: string[] }`；这只是入口结束契约，不要求脚本输出业务 JSON。脚本非零 exit code 正常返回，由能力解释测试失败。`context` 提供原始输入、`attemptId`、`actualSha`，脚本工作目录 `/workspace`，产物写入 `/artifacts`。一次尝试内必须逐次 await 脚本；入口提前返回时保持 unknown，晚到输出不会改写终态。返回值经 JSON roundtrip 验证，不能使用被 JSON 省略的 undefined/function/symbol 作为 business。没有编排器并发限制或通用 worker/timeout。具体脚本负责自己的超时行为。

启动前先事务保存尝试、当前配置版本、能力与环境标识，再保存实际 SHA、独立目录与容器标识。任何必要保存失败都不启动脚本；接纳回执只证明提交已保存，不承诺启动成功。SQLite 与进程启动不是原子事务。每个尝试从登记的本地 repo 导出固定完整 SHA 的 blobs，目录位于 `DATA/attempts/ATTEMPT_ID/workspace`，没有 `.git`、remote、未提交文件或 checkout hooks。导出使用 Git `ls-tree`/`cat-file`，不执行 archive exporter；禁用全局/系统 Git 配置、fsmonitor、replace objects 和 partial-clone lazy fetch。当前拒绝 symlink/submodule，不隐式拉取外部代码。每个 blob 上限 64 MiB。

薄 Docker adapter 固定 `--pull=never --network none --cap-drop ALL --security-opt no-new-privileges --read-only`，以控制服务 UID/GID 运行，只有该尝试代码与产物目录可写挂载以及隔离 `/tmp`。不注入宿主环境、凭据、原 repo Git 目录、home 或 Docker socket；镜像/daemon/入口启动失败不回退宿主。Sandcastle 0.12 的 public Docker API 已核对，但其默认挂载 worktree 与原 Git 目录，不能满足此处无推送权限边界，因此这里直接调用 Docker CLI。管理员必须预部署无生产凭据、无敏感文件、适合该 UID 的可信镜像，建议固定 digest；本应用不会清洗镜像。无网络不等于完整安全隔离，Docker daemon/内核漏洞、资源耗尽、代码中已有秘密仍需部署边界防护。

```sh
pnpm start logs REQUEST_OR_EXECUTION_ID --socket /srv/orchestrator-data/control.sock
pnpm start artifact REQUEST_OR_EXECUTION_ID --name result.txt --socket /srv/orchestrator-data/control.sock
# 多个尝试时可明确选择；默认读取最后一次
pnpm start logs EXECUTION_ID --attempt ATTEMPT_ID --socket /srv/orchestrator-data/control.sock
```

`logs` 返回 stdout/stderr 最后 64 KiB、`truncated`、`complete` 与 attempt/SHA；不存在的流返回 `null`，未完整结束不宣称日志完整。原始流随运行写入权限受限的文件；`exec` 返回每流最后 64 KiB。产物必须是 `/artifacts` 内单层普通文件，名称仅字母数字、`.`、`_`、`-`，不跟随 symlink，单个读取上限 8 MiB。引用绑定 attempt 与实际 SHA，CLI 以 base64 读取。日志与产物不做秘密过滤，不要让脚本输出秘密。

状态 `starting`/`running` 表示本控制实例的进展，`completed` 表示入口结束已保存；`contract: valid/error` 与 `business` 分开，测试失败可正常完成。`start_failed` 表示明确启动失败，`unknown` 表示事实/保存未决，需人工核查。结束保存失败在当前查询显示 `persistenceError`，持久化状态仍保留原值；重启后原 `starting/running` 投影为 `unknown`，包含 `persistedRunState` 与 `requiresAttention`，不虚报完成或自动重跑。控制服务中断或 Docker client close 不保证容器已停止；每次命令保留容器，inspect 的 `State.Running/Status/ExitCode` 才是可信结束证据，证据缺失或仍在运行保持 unknown，脚本真实退出 125/126/127 也可以正常完成。确认结束后能力解析失败记录 completed + contract:error。尝试保留容器名与结束证据用于人工核查。容器不自动删除（包括已结束容器），需要管理员依据记录确认停止后定期清理，不能把 client 退出视为停止证明；本版本不实现自动清理。

## 主 Agent 额度与排队（#21）

配置顶层可选 `primaryAgentLimit` 设置全局主 Agent 上限，`repos` 的同名字段设置该 repo 上限，均须为正安全整数。省略全局字段不设全局上限，省略 repo 字段默认串行，旧配置无需修改。配置只在启动时加载，降低额度不会停止已有尝试，新请求等待占用降到额度以下。

```ts
primaryAgentLimit: 4,
repos: [
  { id: 'alpha', location: '/srv/repos/alpha' }, // 默认 1
  { id: 'beta', location: '/srv/repos/beta', primaryAgentLimit: 2 },
],
```

控制服务按已持久化的提交顺序扫描最早可启动请求，可跳过额度已满的 repo。尝试保存成功、进入 `starting` 即占位，包括环境准备；保存失败不开始实际执行。启动中、运行中、未知及停止未确认的主 Agent 保留额度，重启不会释放。可信结束或恢复者 `confirm-stop` 确认后可调度等待请求，单独发送取消不释放。未知记录中的停止确认仍保留供后续 `resolve`/`retry` 核对，不要求先重试才释放额度。

独立确定性执行不占主 Agent 额度，也不因主 Agent 满额等待，仍须保存成功并确认旧尝试停止。内部工具/MCP 与 Agent 自派子 Agent 不另排队、登记或占额。额度不保证总进程数、模型调用数、成本或全机资源；没有优先级、抢占、分布式租约或等待时长保证。

## 单角色报告运行（#19，本地实现）

可选 `roles` 定义业务身份：`id`、`description`、`validate(input)`、`buildPrompt({input,repo,actualSha})`、`skills: string[]`、`tools: string[]`、`validateReport(report)`。工具 ID 引用可选 `tools: [{id,description}]` 中的已部署工具说明，不另建通用工具框架。`providers: [{id,agent}]` 接受公开 Sandcastle `AgentProvider`；`roleBindings: [{role,provider,environment,commit(input)}]` 将角色绑定 provider/环境与完整 SHA selector。同一角色可提交到不同登记 repo，用现有 `--capability ROLE_ID`，没有 binding 的角色只接纳排队。角色和确定性 capability ID 不可重名，旧配置无需新增字段。

角色 Prompt、skills/tool 说明、配置版本、provider/environment 身份与固定 SHA 在模型启动前必要保存，配置不热更新。输出格式由角色负责：`validateReport(output: string)` 接收真实文本，可直接返回文本或自行解析 JSON，并返回可 JSON 保存的业务报告；抛错表示返回契约错误。运行 error/exit code 与报告契约分别保存，非零退出的有效报告不会被丢弃。`show` 保存输出、迭代/session 引用、exit code、报告与契约状态；正常 CLI 退出不代表业务成功，不把建议转为请求。每次 retry 新目录、新 `orch/ATTEMPT_ID` branch、新 session，不 resume/fork。session 导出通过 `docker exec -i CONTAINER cat -- PATH` 流式写入宿主文件，兼容 `/home/agent` tmpfs，不依赖无法读取该挂载内容的 `docker cp`；文件导出不使用 8 MiB 命令缓冲，非零退出或宿主写入失败仍按 session capture 失败记录。

只读报告设施从本地 repo 创建独立无 remote clone，拒绝 symlink/submodule 与目标树 `.sandcastle/.env`；不挂载原 checkout、宿主 home、Docker socket或凭据。public `createSandbox` 创建专用 worktree，薄 `createBindMountSandboxProvider` 将代码/Git metadata 全部 readonly 挂载，root filesystem readonly，只有隔离 `/tmp`、`/home/agent` tmpfs 可写；Git setup 写隔离 home 的 global config，repo保持只读。管理员配置可信预部署 `docker.image` 与可选 `docker.env`、`docker.network`（默认 none，不允许 host）。未选择下述 `connection` 时，模型认证仍由管理员在环境中明确提供，不自动注入宿主环境或 GitHub 写凭据；provider 的 `agent.env` 不自动注入长生命周期 Sandbox。旧路径不保存环境快照，但不保证日志/模型输出秘密过滤。

不使用内置 SDK Docker provider：0.12.0 的 shutdown hook 在 exit/SIGINT/SIGTERM 调用 `docker rm -f`，没有公开 opt-out，违反未知状态不强杀。这里不注册这种 hook、不调用 SDK close/abort、不自动清理容器。管理员须在核查结束后清理保留容器。角色取消先保存协作意图，再向仅本 attempt 的目录发布 stop 文件，readonly 挂载 `/orchestrator-stop/requested`，Prompt 要求定期检查并及时返回；通知失败及必要保存失败可查询，不 close/kill，也不保证 Agent一定响应。原运行得到 CLI exit evidence 后可保存 cancelled。未知状态仍须人工确认停止后恢复。

`Sandbox.run` resolve 与模型文本都不能证明退出。公开 provider command 外包 subshell，在 CLI 实际结束后写随机 exit marker，stream parser 精确识别该 marker，保留原 stdin/parser/session 契约；marker 缺失保持 unknown。该证据用于可信设施中的生命周期观察，不是抵抗恶意容器/模型伪造的安全认证。显式 `idleTimeoutSeconds: Infinity`、`completionTimeoutSeconds: Infinity`、`completionSignal: []`，不增加 token/费用/turn 预算。Git setup/commit collection 沿用 SDK 10s/30s 真实设施超时；Docker启动与管理员工具各自负责超时，编排器不强杀。

2026-10-11 已在授权环境完成真实只读单角色运行与人工 retry，通过 Claude Code → CC-Switch → Codex OAuth 路径验证挂载、认证、报告、session 导出和退出证据，详见 [验收记录](issue-19-real-acceptance.md)。此结果不代表其他 provider 或真实协作取消响应通过；并发调度不在本实现范围。

### 执行级授权连接与模型继承（#80）

可信配置可在 Claude Code provider 上明确选择 `connection`，示例和完整白名单见 [连接投影指南](connection-projection.md)。该选择授权服务在每次角色尝试开始时读取指定 settings JSON 或当前服务进程环境，不扫描 home、不读取 CC-Switch 数据库，也不复制宿主 `/login`。连接秘密不写进 TypeScript 配置或任务输入。未配置 `connection` 的旧 provider、显式模型、记录和 socket 协议保持原行为。

```ts
import { claudeCode } from './src/connection.js';
const providers = [{
  id: 'claude',
  agent: claudeCode(), // 无 --model；显式 claudeCode('backend-model') 原样覆盖。
  connection: { source: 'settings', path: '/absolute/authorized/settings.json' },
}];
```

投影支持 Anthropic Messages-compatible client endpoint 和静态 API key 或 Bearer token，不限定模型厂商。显式容器可达 endpoint 原样使用；#81 为所选 HTTP loopback endpoint 增加本次执行所有的 TCP 桥，仅支持能核验 gateway 的本机 Linux rootful Docker bridge。HTTPS loopback 的 TLS/SNI 改写明确不支持，不关闭证书校验；详见[桥接范围与验收](connection-projection.md#执行级-localhost-桥81)。不改宿主执行、不新增认证方式。普通角色可显式配置 `docker.network: 'bridge'` 出网；历史 PR 分析示例的 endpoint-only 网络要求限于其当时受控部署，不是通用接入新门槛。host 网络禁令、确定性测试禁网、路径/权限及 unknown 人工核对边界不变。

受控测试验证 live 切换、模型参数、冲突/不支持依赖失败、日志/报告/session 秘密过滤。2026-10-16 已获准用真实 Docker、原版 Claude Code 2.1.296 和合成凭据完成受控 Messages endpoint 验收，见 [#80 Docker 验收记录](issue-80-docker-acceptance.md)。未读取私人连接或调用真实模型；真实 provider、代理和 localhost 桥仍未据此验收。

### 协作停止与显式期限（#20）

`roleBindings` 可选 `attemptDeadlineSeconds`（有限正数，支持小数秒）；省略时无期限，仅适用于主 Agent 角色，不影响确定性执行。尝试进入 `starting` 时一并保存期限秒数、`createdAt` 和绝对 `deadlineAt`，包含准备与启动时间，不计排队。到期先保存 `cancellation.kind: deadline`、原因和请求时间，再沿用取消通路发布只读停止文件；不延长期限、不暂停续跑、不自动重试。准备阶段收到停止意图则不启动 Agent，保存 `never-started` 证据。

停止文件保留 `requested` 首行并增加 attempt/execution 身份、原因、请求时间及可读说明。Prompt 让 Agent 自主选择检查点，停止开展新工作、整理结果并正常结束，长工具调用可能延迟响应。`cancellationNotification: published/failed` 区分发送结果；published 不是结束证明。未配合、发送失败或保存未决继续保持 unknown，禁止替代尝试，后续调度必须继续计入主 Agent 额度；本版本尚未实现额度调度。可信 CLI 退出后才记录实际取消终态；取消不证明子 Agent、工具或远端任务停止，也不撤销写入。

配置和 SQLite JSON 字段均为兼容性增加，原 CLI/socket 命令、旧记录及停止文件存在性检查保持有效。经恢复者核实并 resolve 的未决执行，其历史 `persistenceError` 保留为审计信息，不再单独阻止到期清理；未 resolve 的错误仍保护相关证据。回退到此前版本不会执行新增期限，需先停止服务并核查活跃尝试，再按下述备份回退流程处理。真实正常路径验收固定在 [issue #20 实测代码版本](issue-20-real-acceptance.md)；退出证据保存失败（35e6219）及合并后的到期清理交互均由受控 CLI/socket 回归覆盖，未在该次真实运行中验证。#19 的真实运行记录不能替代该验收。

## 已有 MCP 服务（#23）

普通角色可选 `mcp: [{service, tools, requiredCapabilities?}]`，引用管理员 `mcpServices`。每个服务定义 `id`（字母数字、`_`、`-`）、原工具名称 `tools`、`access`（实际权限与网络限制）、`context: 'none' | 'code'`、`capabilities` 和 `prepare(context)`。`capabilities` 必须逐项描述 `context/directory/logs/longTasks/query/cancel/retry`，不可用填 `null`；角色要求的能力为 null 时，该尝试明确 `start_failed`，不启动 Agent。声明不替代实际工具发现，运行中工具缺失/服务不可用由原 provider 和角色报告如实反馈。

`prepare({repo,actualSha,workspace,attemptId})` 是可信管理员代码，返回 `{configFile, binding?}`；`configFile` 为宿主绝对路径的普通原生 provider MCP JSON 文件，readonly 挂载到 `/orchestrator-mcp/SERVICE_ID.json`。不解析或转换传输、认证、参数或返回契约；文件中的服务必须已能从选定环境访问，stdio 命令与所需库必须部署在镜像内，HTTP/SSE 地址及认证沿用 provider 原生支持。管理员确保每份文件只含本角色获授权的服务及工具，不把工具引用当权限过滤器。

`context: 'code'` 强制核对可信 `binding: {repo,actualSha,location}` 与本尝试 repo/SHA；`location` 记录服务实际访问目录或位置，而非默认当前 checkout。`prepare` 必须通过服务已有可信元数据、服务部署绑定或宿主 Git 核对真实版本及访问位置，不得把传入 SHA 原样回显当核验，更不得使用模型自报结果。服务无法提供可核验的 code binding 就明确失败；与代码无关的服务可用 `context: 'none'`，不得据此宣称它读到了本次代码。管理员负责核验后到使用期间绑定的稳定性（固定只读版本/独立目录），编排器不冻结外部服务状态。

provider 可选 `configureMcp(agent, connections): AgentProvider`，`connections` 仅含服务 ID、容器配置路径和角色工具名。Sandcastle 0.12.0 的 `AgentProvider` / `ClaudeCodeOptions` 无 MCP 参数，故提供 `src/mcp.ts` 的 `configureClaudeMcp` 最薄适配：在原 `buildPrintCommand` 后附加 Claude Code 原生 `--strict-mcp-config --mcp-config FILE...`，保持 prompt stdin、parser、session 和原命令契约。其他 provider 由管理员按其既有配置方式提供同等适配，不回退为只有 Prompt 说明。没有 MCP 的旧角色不调用该 hook，保持原路径。

```ts
import { claudeCode } from '@ai-hero/sandcastle';
import { configureClaudeMcp } from './src/mcp.js';
// 普通配置中的增量，保留其他 repos/environments/roles/bindings：
const providers = [{ id: 'claude', agent: claudeCode('your-authorized-model'), configureMcp: configureClaudeMcp }];
const mcpServices = [{
  id: 'existing', tools: ['inspect'], context: 'none' as const,
  access: '管理员部署的只读服务；仅允许授权目标；网络由环境和服务限制',
  capabilities: { context: null, directory: null, logs: null, longTasks: null, query: null, cancel: null, retry: '服务不重试' },
  async prepare() { return { configFile: '/srv/admin-mcp/existing.json' }; },
}];
// 对应 role 添加 mcp: [{service:'existing',tools:['inspect']}]
```

凭据留在受限原生配置/服务环境中，不经 Prompt 或模型工具参数传递，编排器不主动保存 native config 内容、认证头、环境或 configFile 宿主路径。`show` 仅增量保存服务/工具 ID、明确公开的能力与权限说明、可信绑定；这些说明、binding、业务报告、日志和 session 不是秘密过滤器，管理员与服务不得输出凭据。挂载配置对容器进程可读，因此须使用专用最小权限凭据并信任镜像/provider；本实现不宣称秘密对容器内模型工具不可读。

容器外 MCP 服务不继承只读容器隔离；服务及管理员落实目标目录、网络、身份与副作用限制，必要时显式配置环境网络。角色须区分业务结果、故障和未知，日志引用不可读时报告不可用，不把 URI 当已读证据。CLI exit marker 仅证明 Agent CLI 结束，不能证明 MCP 长任务停止。超时/断连后的外部结果及停止状态仍未知；取消只沿用 #19 协作请求，不加统一远端取消、自动恢复、重试或补偿。原服务重试和副作用幂等限制必须在 `capabilities.retry` 写明，人工 retry 仍先核对外部结果。

验证：`tests/roles.test.ts` 经真实 CLI/socket、Sandcastle `claudeCode` 的真实 builder/parser、受控 CLI harness 和真实 stdio MCP `initialize → tools/list → tools/call`，验证反馈、不可读日志引用、不可用服务、运行时工具缺失、可信绑定不匹配与必需能力缺失。未知结果用例让受控服务实际收到 `tools/call` 后关闭 stdio，harness 按调用派发阶段将断连反馈为 `business.outcome: 'unknown'`、`remoteStopped: null`；CLI 正常结束仍为 completed，不混淆业务未知与进程生命周期未知。原 missing-exit 用例独立验证退出证据缺失时 attempt unknown；凭据未出现在 show/logs。harness 不是实际 Claude Code CLI，不调用模型、不运行真实容器、不外部写入。2026-10-11 已在授权环境完成真实 Claude CLI → CC-Switch → Codex OAuth 的只读 stdio MCP red/green，独立服务调用记录与模型反馈吻合，Docker 只读配置挂载已核实，详见[真实验收记录](issue-23-real-acceptance.md)。默认测试不调用模型；显式验收脚本及未复跑的新增断言见该记录。HTTP/SSE、真实第三方服务、其他 provider 和真实远端取消/重试仍未验收。

## PR 共性问题分析（#25，本地实现）

`examples/pr-analysis.ts` 提供普通角色、Prompt、Skill 和具体只读 `pr-snapshot` 工具；在可信部署配置中引用 `prAnalysis`，配置获准 GitHub repo/PR 白名单、快照路径、登记 checkout、固定 SHA selector、已授权 provider 和预部署镜像。没有分析调度模式，不要求报告 JSON，不固定收集/分类步骤。角色按需调用 `node /orchestrator-tools/call.mjs pr-snapshot '{"number":31}'`；工具不是只写在 Prompt 中的说明。

本增量采用管理员提供的离线证据，不联网采集或独立核验 GitHub。快照格式为 `{version,collectedAt,pullRequests:[{repo,number,url,updatedAt,headSha,body,reviews,diff,missing,truncated}]}`：时间为可解析日期，SHA 必须完整，正文/diff 为字符串，reviews 为数组，missing 为缺失内容名称数组，truncated 必须显式布尔值；文件须为普通非 symlink，最大 64 MiB。管理员负责来源授权和快照真实性；不要填凭据。工具只读部署时固定的路径，参数只接受白名单 PR number，不能选择任意文件、repo、命令或 GitHub API。每次观察返回 `source.kind: administrator-snapshot`、version、采集时间、完整快照 SHA-256、`verifiedAgainstGitHub:false` 与 PR 版本/SHA、缺失/截断线索。PR headSha 是快照所述版本，不冒充 checkout 的实际 SHA；后者仍由 Git 核对并绑定尝试。

可选 `tools[].read(input)` 是管理员部署的可信代码，不是函数名称保证只读。这个具体工具仅使用文件只读打开，不调用 shell、GitHub 或写 API。专属工具 Unix socket 仅开放当前角色绑定的工具，拒绝 64 KiB 以上请求及额外字段；不挂管理 socket、证据源目录、宿主凭据或生产写凭据。工具目录 readonly 挂载，socket `0600`，容器与控制服务使用相同 UID/GID。示例 `network:none` 默认 fail-closed，仅可使用受控离线 provider，不宣称真实模型可运行。该示例的历史 endpoint-only 网络要求属于当时受控部署；通用真实 harness 接入允许管理员明确选择普通 Docker 出网，不以额外网络治理为前置条件。本增量不提供 GitHub 凭据、不回退宿主或 host 网络，也不建设网络配置平台。Docker UID/socket 连通性与实际模型连接须在授权环境验证。

```sh
pnpm start submit --socket /srv/orchestrator-data/control.sock --repo example \
  --capability pr-analysis --source manual \
  --input '{"sha":"0123456789012345678901234567890123456789","pullRequests":[31,32],"question":"哪些问题反复出现？"}'
pnpm start show EXECUTION_ID --socket /srv/orchestrator-data/control.sock
pnpm start artifact EXECUTION_ID --name observations.jsonl --socket /srv/orchestrator-data/control.sock
pnpm start artifact EXECUTION_ID --name report.txt --offset 0 --socket /srv/orchestrator-data/control.sock
```

工具观察独立写入每次尝试的 `observations.jsonl`，包含工具、参数、观察时间、attempt/实际 SHA、结果或故障；同一次尝试的观察记录逐条串行保存，避免并发大结果交错损坏 JSONL；工具读取仍可并发。每个调用的观察保存成功后才回复 Agent，失败不交付结果；失败追加会在同一串行队列内将同一已打开的普通文件回退到追加前长度，保留此前完整记录；回退成功后后续调用仍可保存独立可读的观察。若回退失败，该尝试的后续观察保存与结果交付均拒绝，不继续向可能损坏的 JSONL 追加；该尝试的证据缺口仍保留，`show.toolObservationError` 明示缺口。Agent 等待返回后，工具设施停止接纳新调用并等待已接纳的 handler（包括客户端已断开的调用）实际结束，再发布最终状态与业务结果；等待期间原始报告可读，但不发布完成或停止确认，不强杀或超时冒充工具结束。设施关闭不证明未知 Agent 已停止。任一工具观察保存失败后，即使 Agent 正常退出并返回限制说明，该尝试仍为 `unknown`，保留实际 `exitCode`/`stopConfirmation`、原始报告和来源引用，不发布 `business`、`businessReference` 或 `contract`；未核对处理前，即使超过 30 天也不清理其日志/报告。普通工具调用失败但故障观察成功保存时，仍可正常完成并报告限制。模型报告另存 `report.txt`，建议不自动变成修复、请求、评论或 Issue。旧尝试事实/报告不被 retry 或来源变化改写；重试可能得到新版本证据，其 digest/时间另行记录。报告应区分观察与推断，证据不足或工具故障应表达限制，不能把“没有证据”写成“没有问题”。

新角色输出与校验后的业务值各超过 64 KiB 时文件化：`output` 只保留不超过 65536 UTF-8 字节、不会拆开 Unicode 字符的预览，仅实际省略内容时设置 `outputTruncated:true`，完整模型文本见 `report` 引用；大的业务值不变类型或伪装为内联 `business`，改用显式 `businessReference` 指向 `business.json`（JSON 编码原校验返回值）。小报告的 `output/business` 与历史内联记录保持原形状。取消请求后的完成不发布 `business`、`businessReference` 或 `contract`；原始 `report.txt` 与工具观察仍可读取。`report.complete` 表示有 CLI 结束证据，`truncated:false` 表示保存的输出未裁剪，不保证业务证据充分。不存在输出不宣称有报告；文件缺失/非普通文件读取失败。

`artifact` 不带 offset 保持原 base64 响应和 8 MiB 上限；新增 `--offset`（socket 数字字段 `offset`）按字节读取至多 1 MiB，响应含 `offset,nextOffset,size,complete`。从 0 开始，依次以 nextOffset 读取至 complete，把每块 base64 解码后的字节拼接再按 UTF-8/JSON 解析；不要逐块解码文本以免拆开多字节字符。这样大报告/事实可以完整读取，`logs` 仍是明确标注截断的 64 KiB 尾部，不替代报告。新增 JSON facts/文件不改旧 SQLite schema，备份/回退必须包含完整 DATA；旧版本不能读取新分块协议，回退规则仍按下节执行。

受控 CLI/socket 与实际工具入口测试覆盖授权范围、故障/证据不足、来源变化保留旧事实、观察保存失败和 9 MiB 报告完整读取。**本任务未授权或执行真实模型、容器、远端写入；#25 的真实端到端业务质量与 Docker socket/模型环境验收仍待明确授权，不能借用 #19 验收声称通过。**

## 当前尝试 MCP 测试工具（#22）

使用官方 stable `@modelcontextprotocol/server/client` 2.3.1 与 Zod 4.6.5。只为显式 opt-in 的 Claude Code provider 注入 `--strict-mcp-config --mcp-config /orchestrator-mcp/config.json`；Sandcastle 没有原生 MCP 配置字段，通过公开 `buildPrintCommand` 保留原 stdin/parser/session 契约。其他 provider 的 MCP 未支持，不冒充兼容。旧 provider、描述型 tools、配置、CLI/socket 协议与历史记录保持不变。描述型 tools 仍允许空 description、空 ID 与重复 ID，角色说明仍取首个匹配项；仅可执行 tools 要求非空 description、合法 MCP ID，且 ID 不可与任何其他工具重名。

```ts
import { z } from 'zod';
// test-commit 的 execution 增加 workspace: 'readonly'，保留 commit selector。
// 例如 execution: { workspace: 'readonly', commit(input) { return FIXED_SHA; } }。
// 添加到既有配置；角色 tools 引用 run_tests。
providers: [{ id: 'claude', agent: claudeCodeAgent, mcp: 'claude-code' }],
tools: [{
  id: 'run_tests', description: '运行固定版本测试，scope 只接受 smoke/full；返回业务结果、运行故障及读取引用。',
  capability: 'test-commit', inputSchema: z.object({ scope: z.enum(['smoke', 'full']) }).strict(),
}],
```

MCP 只能绑定显式声明 `capability.execution.workspace: 'readonly'` 的能力；独立入口对这些能力也 readonly，机械保持同一执行限制。旧能力默认 rw 不变，不声明 readonly 则不能暴露为当前只读角色的工具。业务脚本只能写 `/artifacts` 或 `/tmp`。每个工具显式绑定已具备独立入口的 `capability`，参数经 strict Zod schema 和原 `capability.validate` 校验；与独立入口一致，校验器返回值或原地修改不改变执行输入（包括嵌套参数）。不推断脚本契约。管理员声明业务参数与实际限制，不把身份或凭据作为工具参数。repo、SHA、attempt、当前 Sandcastle host worktree 与能力环境由宿主可信设施绑定；不调用工具能力的 SHA selector，不建立新的请求、尝试或并发占用。工具直接复用原 `capability.run(context)` 和真实 Docker `context.exec`/inspect 语义；独立 CLI 入口仍有自己的尝试与目录。

角色镜像只需可执行的 Node.js，无需安装 MCP SDK。容器内 `node /orchestrator-mcp/bridge.cjs` 仅将 stdio 字节转发到专属 `tools.sock`；官方 SDK、业务函数与 Docker client 留在宿主。只挂载此 attempt 的受限目录，角色 root/repo/MCP 挂载 readonly、无 Docker socket 和 management socket。代码使用当前 attempt worktree **readonly**，不是另行导出 snapshot；测试只能写 `/artifacts` 与 `/tmp`，需要原地 build/install 的能力不适合这个只读角色。工具使用能力绑定的无网络测试镜像，不继承角色模型认证环境，管理员仍须保证镜像可信与能力输入校验不接受凭据。

普通调用直接等待，逐次执行；同时到达的调用拒绝，不排队。没有自动重试、kill、统一 job 或取消工具。脚本非零返回由原能力解释为业务失败；启动/契约故障与 unknown 分开。断连或模型结束不证明工具停止：已启动工作继续，unknown 后拒绝再启动，parent attempt 不因 Agent exit marker 虚报停止；人工恢复必须核查记录中的所有工具容器。

`show` 在当前 attempt 的 optional `toolCalls` 保存能力、环境、SHA、call ID、容器状态、结果与日志；每次调用只新增 `tools/CALL_ID` 日志/产物目录。MCP 返回至多 16 KiB 的 JSON 摘要，超过时明确 `summaryTruncated: true`，保留 bounded `businessPreview`/关键错误/产物预览（预览是文本，不要求统一业务 schema），完整结果是 `result.json`。`read_tool_file({callId,name,offset,kind?})` 提供 stdout.log、stderr.log、result.json 和已注册产物，base64 分块每次最多 64 KiB，以 `nextOffset` 续读，`truncated` 表示还有内容。读取与日志／结果同名的已登记产物时传 `kind: 'artifact'`；省略 kind 保留原行为（保留名称读取日志／结果，其他名称读取已登记产物）。显式 artifact 仍要求产物已登记。拒绝跨调用路径、文件或证据父目录的 symlink 与非普通文件，不把宿主路径当读取入口。日志保留完整原始流，不做秘密过滤。服务退出不自动重连工具，旧记录仍用于人工核查。

受控测试从 CLI/socket 建立角色尝试，通过真实 MCP stdio 与官方 client 验证成功、业务失败、启动故障、unknown、畸形参数、身份/路径拒绝及大日志读取；真实模型/镜像的验收另行授权执行，受控 Docker 替身不算真实执行验收。

## 实现角色到 Draft PR（#24，受控验收）

`examples/implementation.ts` 是普通 Role/Prompt/Skill/tools 配置增量。管理员显式设置 `roleBindings[].workspace: 'implementation'`；旧角色默认 readonly 不变。SDK 原代码与 Git mounts 始终 readonly，容器内初始化独立 `/implementation` clone 与本尝试专用 `orch/ATTEMPT_ID` 分支，初始化退出证据保存后才开放 MCP/模型。宿主 SDK postprocessing 只处理原只读代码，SDK `commits` 不作为 implementation 提交证据。

实现角色调用既有 readonly capability 时，bound execute 的第一条内部命令在无网络容器收集当前 HEAD 与文件，第二条执行原 capability。两阶段共用串行命令、日志、Docker inspect 与 unknown 门禁。代码采集非原子，不保证原工作区瞬时一致；测试的是独立导出目录的实际 `revision.treeSha`。`actualSha` 是捕获 HEAD，dirty tree 不能冒充该 commit 已验证；`baseSha` 是原上下文。摘要、result.json、read_tool_file 和测试产物包含相同 revision。发现 symlink/submodule 拒绝；祖先目录竞态受容器可见范围约束，不声称全面阻止 symlink 竞态。宿主不读取或运行 implementation Git/config/filter/fsmonitor/hooks。

管理员为获准测试 repo 配置 `publication: {github:'OWNER/REPO',remote:'https://github.com/OWNER/REPO.git',base:'main',env:{...专用凭据}}`，并将 `{id:'publish_draft',description:'...',publication:true}` 绑定角色。写入设施只接受 `operation: publish|query`、既有测试 `callId`、title/body；repo/branch/base/凭据不可由模型选择。发布从独立导出 tree 在可信临时 Git 中构建 commit，以原 base 为 parent，核对 tree 与测试证据一致。发布 commit SHA 与采集 HEAD 分别保存。实际写入者查询远端 branch/PR，存在则拒绝替换，push 前再查 branch，普通单 ref push 后核对远端 SHA，再创建并核验 Draft PR。核查与 push 之间仍可能竞态，遵循普通 Git fast-forward/non-fast-forward 语义；不承诺服务端 create-only、分支锁或统一幂等。Git/gh 专用凭据仅在宿主 writer 环境，不注入模型或测试容器；部署需配置 Git HTTPS credential helper 或既有专用 Git 认证，不能用 unrestricted 模型凭据替代。

不提供 merge/force/comments/issues/settings/deploy 或任意写命令。响应丢失保存未知 publication，禁止再写，仅允许查询原 callId；查询 receipt 保存 branch SHA、PR 地址与 Draft/head/base 线索，不自动裁决未知结果。角色退出仍 unknown，恢复者须沿用 parent 与 tool 的 `confirm-stop → resolve/retry` 核对旧产物，retry 使用新分支，新需求/基线另建请求。不存在统一幂等、补偿或自动对账。

```sh
pnpm start submit --socket /srv/orchestrator-data/control.sock --repo approved-test \
  --capability implementation --source manual \
  --input '{"sha":"0123456789012345678901234567890123456789","issue":24,"issueBody":"管理员提供的获准 Issue 内容"}'
pnpm start show EXECUTION_ID --socket /srv/orchestrator-data/control.sock
```

配置/记录/协议为增量兼容，旧 readonly 与独立能力路径保留。受控 CLI/socket、真实 MCP stdio 测试覆盖 dirty revision、拒绝路径、push/PR 已发生响应丢失及人工恢复。当前 repo 已完成一次获准的真实 CLI/socket、provider、Docker、MCP、普通推送与 Draft PR 样例，独立核对发布 tree 与测试 tree 一致，见 [#24 真实验收记录](issue-24-real-acceptance.md)。该样例仅修改注释，不证明一般实现任务质量；真实响应丢失、取消等故障未在本次验证，不引用 #19/#22 验收替代。

## 取消与人工恢复

重启扫描可执行的历史 queued 主 Agent 请求，历史确定性请求仍保持排队；不会重跑、重连或接管旧 starting/running 尝试。`show` 的 `location` 如实返回容器名；harness process identity 和 reconnect handle 不可得时为 `null`，不能据此声称已停止。

```sh
pnpm start cancel EXECUTION_ID --socket /srv/orchestrator-data/control.sock --reason '停止该请求'
pnpm start confirm-stop EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已在 daemon/宿主核查停止' --reason '控制服务中断'
pnpm start resolve EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对并保留外部结果' --reason '结束未决' --external-results '相关外部结果及核对证据'
pnpm start retry EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对，允许再次执行' --reason '重新执行' --external-results '相关外部结果及核对证据'
```

socket 对应命令为 `cancel/confirm-stop/resolve/retry`，使用 `id`、`reason`，人工操作还需 `source/handling`，resolve/retry 还需 `externalResults`；全部输出 JSON。`--attempt` 通常只能指定当前尝试；工具停止确认和日志/产物可选择历史尝试。

不传 `--call` 的 confirm-stop **只确认 parent attempt**，不会推断或追溯确认工具停止。对每个仍未决、需核查或停止未确认的 `toolCalls`，先实际核查工具容器及外部结果，再运行 `confirm-stop EXECUTION_ID --call CALL_ID --source operator --handling '工具停止核查方式' --reason '停止依据' --external-results '外部结果核对证据'`（同样传 `--socket`；历史工具加 `--attempt ATTEMPT_ID`）。socket 使用可选字符串 `call`、`attempt` 和必填 `externalResults`。确认不停止工具，也不重写其原 `runState/error/requiresAttention/persistenceError`；只增量保存工具 `stopConfirmation.kind: manual` 审计。任何入口仍 live 时拒绝人工确认。

所有待核对工具分别确认后，resolve/retry 才能事务保存工具 `reconciliation` 并结束未决或创建替代尝试；父退出或父人工确认均不能绕过。旧程序留下的 resolved/completed parent 与 unknown 工具也可先明确确认工具，再 resolve。确认后但尚未 resolve/retry 时仍保护证据。

取消首先事务保存意图；无尝试的 queued 直接 cancelled。运行尝试后台调用 `docker stop --timeout -1`，只协作停止，不使用默认超时后的 SIGKILL，不强杀 harness/client。管理回执只证明取消意图已保存。协作停止可能无限等待，状态保持 unknown；stop 失败、无可用容器身份或 inspect 不可得也不宣称停止。只有 inspect 确认非运行且本实例 capability 入口已结束，才能保存 cancelled + `stopConfirmation.kind: docker-inspect`。已退出的前一容器不证明宿主入口结束；入口仍 live 时保持 unknown，人工 confirm-stop/resolve/retry 也不能绕过。stop 失败后，原命令正常退出的可信 inspect 加入口结束仍可完成取消。完整 completed 不被后来的取消覆盖，取消不回滚外部写入。

人工 confirm-stop 只记录恢复者的来源、处理方式和原因，标记 `kind: manual`，不冒充独立验证。确认停止仍保留 unknown；resolve 才结束未决。任何未确认停止的旧尝试阻止替代尝试。保守要求每次 resolve/retry 都记录外部结果和处理说明；编排器不核验所有远端事实，恢复者必须先实际核对再操作。retry 在原 execution 下新增尝试，保留旧记录及目录、日志/产物，使用当前部署配置。选定的完整 SHA 在创建尝试同一事务中必要保存，之后再验证 Git 实际 SHA；必要保存失败不启动。已存在实际 SHA 时固定该 SHA，即使当前 commit 解析配置改变；实际 SHA 尚未保存时沿用原选定 SHA。旧历史尝试既无实际 SHA 又无选定 SHA 时拒绝 retry，不能重新调用当前 selector 猜测原基线；核对后只能提交明确的新请求。原需求或基线变化应 submit 新请求。新尝试没有恢复内部工具位置；晚到旧尝试回调不能改写已处理旧尝试或新尝试状态。

### 存储升级与回退

自动增量创建 `execution_management` 表并扩展 attempts 的 JSON facts，不删除或修改旧表列；旧记录无新字段也可读写。升级前停止服务、核查底层容器并备份完整 DATA（SQLite、attempts 目录），不要仅备份数据库。旧二进制能读取新增字段但不理解取消、恢复及固定重试基线语义；存在新状态或多尝试时不能直接降级继续执行。回退应停止新服务并确认底层停止，恢复升级前完整备份，再部署旧版本；恢复备份不撤销外部副作用，必须人工核对，避免重复提交。

## 故障定位与外部通知

沿用 CLI/socket，不提供监控平台。先按 repo 和状态查询，再用 executionId 查详情。`start_failed` 是启动失败，`unknown` 需要人工核对；`completed` 也可能带 `contract: error`，不能只查状态判断业务结果。业务失败由能力的 `business` 契约解释，通用查询不会猜测业务字段。提交前的校验拒绝不在 `list` 中，使用提交回执的 requestId 查 `show`。

```sh
node --import tsx src/cli.ts list --socket "$DATA/control.sock" --repo example --status unknown
node --import tsx src/cli.ts list --socket "$DATA/control.sock" --repo example --status start_failed
node --import tsx src/cli.ts show "$EXECUTION_ID" --socket "$DATA/control.sock"
node --import tsx src/cli.ts logs "$EXECUTION_ID" --socket "$DATA/control.sock" --attempt "$ATTEMPT_ID"
node --import tsx examples/query-attention.ts --socket "$DATA/control.sock" --repo example
```

`examples/query-attention.ts` 是只读外部脚本，调用现有 CLI 的 `list` JSON。成功输出单行 `{version:1,available:true,items:[...]}`，退出码 0，无待处理项时 `items:[]`。每项只含 `requestId/executionId/status/attemptId/reasons`，不转发 repo 名称、输入、错误文字、日志、环境变量、business 或人工处理文字。`reasons` 是 `failed`、`needs_attention`、`stop_unconfirmed` 的组合。脚本检查启动失败、契约错误、unknown/必要保存失败以及有取消意图但没有停止确认的尝试；正常 queued、静默 running 不告警，排队取消没有底层尝试也不算未确认停止。无尝试的启动前失败仍显示 `start_failed`，对应 `execution_failure` 服务日志。`execution.startFailures` 在现有管理 JSON 中保留每次失败的 `recordedAt/configVersion/classification/reason/logEvent`，不保存任意异常文字；重启和人工 retry 都保留历史，没有该字段的旧记录仍有效。日志按 executionId、事件和时间查 journal；可核查配置后人工 retry。脚本查询有 30 秒超时及 16 MiB 输出上限，只约束查询，不约束执行。socket 不可用、CLI 失败、输出解析失败或达到上限，stdout 为空，stderr 单行 `{version:1,available:false,error:"Control query failed"}`，退出码 1。不能把失败当成正常的空列表。

详情提供原始请求、尝试、配置版本、实际/选定 SHA、时间、失败原因、日志/产物引用及人工核对的外部结果。原始输入、日志、模型报告和外部结果可能敏感，只在受限环境查看。管理员按能力所用设施核对远端结果，不从模型文字推断成功。`location.container` 可用于 `docker inspect --format '{{json .State}}' NAME` 和 `docker logs NAME`；`processIdentity/reconnectHandle:null` 表示没有可靠宿主进程身份或重连句柄，不能用猜测的 PID 杀进程。名称是定位信息，不是停止证明。还需核对宿主入口、子 Agent、工具和远端操作。控制服务或主 Agent 退出、取消回执、单个容器退出都不证明全部停止。

服务日志写 stderr，交给 systemd journal 或现有日志采集设施。JSON 包含 `time/event/error`，后台执行错误另含 executionId。事件有 `service_failure`、`service_crash`、`execution_failure`、`execution_failure_save_failed`、`management_failure`。服务日志只记录固定安全错误摘要，不写任意异常消息、stack、认证头或完整环境。已知启动校验错误保留安全分类，其他异常显示 `Control service failed`，管理员结合配置部署版本、journal 时间和受限运行记录定位。失败记账本身失败时服务日志仍有证据，但数据库可能暂留 queued，不能仅凭查询宣称没有故障。SIGKILL、断电无法由被杀进程写日志，由进程管理器的退出记录发现。

可由 cron/systemd timer 在应用安装目录运行查询。通知桥只接收上述摘要，渠道凭据由管理员放在桥自己的受限文件中，不写命令参数或通知内容。以下接法要求 `jq` 和管理员现有的 `notify-summary` 工具，不附带发送实现，也不运行真实通知。

```sh
umask 077
summary=$(mktemp)
trap 'rm -f "$summary"' EXIT
if node --import tsx examples/query-attention.ts --socket "$DATA/control.sock" >"$summary"; then
  count=$(jq -er 'if .version == 1 and .available == true and (.items | type == "array") then (.items | length) else error("invalid query summary") end' "$summary") || {
    echo 'query summary validation unavailable or invalid' >&2
    exit 1
  }
  case "$count" in ''|*[!0-9]*) echo 'invalid item count' >&2; exit 1;; esac
  if [ "$count" -gt 0 ]; then
    notify-summary <"$summary" || { echo 'notification channel unavailable' >&2; exit 1; }
  fi
else
  printf '%s\n' '{"version":1,"available":false,"error":"Control query failed"}' |
    notify-summary || { echo 'notification channel unavailable' >&2; exit 1; }
  exit 1
fi
```

没有配置通知就由管理员主动查询并查看 journal，不承诺及时提醒。通知渠道、jq、timer 或进程管理器不可用时，脚本不能补上这些设施；没有心跳、告警升级、自动重试或自动对账。用 `systemctl status UNIT`、`journalctl -u UNIT` 发现控制进程退出，并通过现有 `OnFailure=` 接管理员通知工具。不要配置自动强杀残留来腾空间。重启只把旧 starting/running 投影为 unknown，不接管内部工具位置；是否自动重启由部署者决定，本项目不提供默认 `Restart=always`。

### 受控演练与处理顺序

运行 `pnpm test tests/management.test.ts tests/execution.test.ts`。新增 operations drill 使用临时 Git repo 和受控 Docker CLI 替身，无模型、容器或外部写入。测试先运行无新输出的宿主入口，确认仍 running；取消后查询显示停止未确认；SIGKILL 控制进程后脚本非零失败；重启保留同一尝试并显示 unknown；查询详情与日志找到 SHA、配置版本、容器定位和 `drill-output`。恢复者核对替身与宿主后 confirm-stop、resolve，再人工 retry，故意返回无效业务契约，脚本报告 failed。服务故障测试另注入含敏感文字的配置异常、未捕获异常和失败记账异常，验证安全 stderr 及退出码。已有 #18 测试覆盖必要保存失败、入口仍 live 时禁止人工恢复及历史记录保护。这些测试不是实际 systemd、Docker、provider 或通知投递验收。

实际环境按同样顺序演练，但必须另有授权，先记录 executionId/attemptId 和配置版本，保存受限日志，再核对 `docker inspect`、设施命令及远端引用。缺证据就保持 unknown，不 retry。确认所有相关活动结束后 `confirm-stop` 记录来源、方法、原因，`resolve/retry` 再记录外部结果；人工确认不是独立验证。默认执行不限时，运行久、无输出或无心跳均不能自动判故障。本次未验证真实退出后的子进程树、远端副作用、systemd 或通知发送。

到期清理通过下述 `cleanup` 管理入口执行。普通清理不能按目录年龄、无输出、控制进程退出或取消意图删除活跃/未确认尝试。先核对执行、尝试、停止证据和外部结果，再单独清理已确认结束的设施；保留人工恢复需要的记录、日志和产物。不要使用 `docker container prune`、`docker rm -f` 或批量 `rm` 绕过这一步。DATA 根目录 0700、socket/新建文件 0600；已有文件权限不会自动递归修复，管理员可用 `stat` 核验，并在停止服务且核查执行后按存储策略处理。不要 `chmod -R` 正在运行的 workspace。备份、导出的日志/产物和通知暂存也须限制权限、访问人员及保留期。日志/产物不是秘密过滤器，脱敏后才可分享，发现凭据泄露先撤销凭据再按授权清除敏感副本。

## 到期清理

外部 cron/systemd timer 或管理员脚本调用同一管理入口；控制服务不内置清理定时器，脚本不直接修改 SQLite。

```sh
pnpm start cleanup --socket /srv/orchestrator-data/control.sock
```

socket 请求为 `{"command":"cleanup"}`，返回 `attempts` 中本次处理或已清理的尝试及 `status`，文件失败带 `reason`。只有整个执行已结束满 30 天、全部尝试已结束且无活跃入口、未决、停止未确认或待核对证据才清理。人工 resolve 从核对结束的记录时间起计时；旧记录缺少可信结束时间则保留，不猜测。重试排队或运行时保留该执行全部历史证据。明确启动失败且已结束的 `start_failed` 尝试，事后 cancel 仅保留取消审计，不额外要求停止确认，也不阻挡已结束重试执行的到期清理；真正取消但停止未确认的尝试仍保留。

只 unlink `DATA/attempts/ID/stdout.log`、`stderr.log` 及已登记的单层普通产物文件，同时清理已登记 `toolCalls` 对应的 `tools/CALL_ID/stdout.log`、`stderr.log`、`result.json` 与已登记产物；工具调用活跃、未决、需核查或停止未确认时保留整个执行证据；原 unknown 等事实仅在工具已明确人工确认停止、核对外部结果且 resolve/retry 已保存 reconciliation 后不再阻挡清理，执行核对结束后仍保留满 30 天。另清理 role 的 `context` 校验快照（仅编排器写入、从不挂载或交给 provider）。不删除整个尝试目录，不处理未登记文件、确定性能力可写 workspace、工具自有未登记文件、provider session/worktree、容器或远端对象。可写 workspace 和未登记产物可能包含工具自有资源，归属无法确认时保守保留，管理员核对后另行处理。拒绝符号链接与非普通目标；没有 provider 自动清理承诺。`cleaned` 仅表示上述已确认自有可弃内容已清理，不表示本地空间全部释放。同步本地删除与单写者状态操作串行，清理不停止或强杀执行。

请求、执行、尝试、业务摘要、恢复说明及外部/session 引用保留；attempt 新增 `cleanup.status`（`cleaned`、`failed`、`unknown`）和时间/失败原因。删除前必要保存 unknown，完成后才记 cleaned；崩溃或结束保存失败保持 unknown，文件失败记 failed，重复调用可安全重试。CLI `logs/artifact` 保留原字段并增加 `availability`；已清理、清理失败或未知返回对应状态、空内容，日志 `complete:false`；没有清理记录但文件丢失返回 `unavailable`。产物仍必须已登记。`show/list` 不再将清理过的尝试或工具调用日志标为完整；保留轻量 `toolCalls` 审计与外部引用。`logs/artifact --call CALL_ID`（socket 可选 `call` 字符串）查询该尝试的工具日志/已登记产物，返回同样的可用状态并附 `callId`；不传 `--call` 的旧查询协议不变。旧程序已标记 cleaned 但未清理工具文件的记录可重复 cleanup 补齐。

无需表结构迁移，只增量扩展 JSON facts，旧记录及管理命令继续可用。旧 parent stopConfirmation 不迁移为工具确认；升级后须逐个补录工具停止与外部结果核对，旧 unknown 工具未明确处理前保持保护。旧版本不理解工具 stopConfirmation/reconciliation，降级不得继续恢复、retry 或 cleanup；使用既有停止、完整备份与人工核对回退流程。升级前备份完整 DATA；删除不可通过数据库回退撤销。旧程序不理解 cleanup 状态，降级后不应继续提供证据查询；需要完整恢复时停止服务、核对外部事实并恢复清理前完整备份。

## 验证

```sh
pnpm test
pnpm run typecheck
pnpm audit
```

管理测试经真实 CLI/socket 启动控制服务，用临时 SQLite 和文件系统验证提交、拒绝、查询、事务失败、服务独占、崩溃恢复和文件权限。`tests/execution.test.ts` 的真实 Docker 用例默认 skip，仅在已获授权主机显式 `ORCHESTRATOR_REAL_DOCKER=1 pnpm test` 才执行。它们使用临时 Git repo 和本地 `node:22.22-alpine` 镜像执行真实无网络 Docker 脚本，验证固定 SHA、独立目录、非零业务结果、日志/产物与隔离限制；需要管理员授权的测试主机和预部署镜像，缺镜像/daemon 时测试失败，不下载或绕过。SQLite trigger 故障注入验证启动前与结束保存失败，受控 Docker CLI 替身验证 client 退出但容器仍运行或 inspect 不可得的未知结束窗口，Git adapter 替身验证明确禁用 lazy fetch。常规 suite 不运行真实业务项目、模型、Docker 或外部写入；受控 MCP 测试使用真实 stdio 协议但不调用模型。授权真实 provider 验收见 [#19](issue-19-real-acceptance.md) 与 [#22](issue-22-real-acceptance.md)，不代表任意镜像安全或内核级隔离已验证。

后续实现沿用这一管理入口，按 #19–#29 增加能力与验收。本版本没有自动恢复或备份管理，不应按完整生产规格部署。


# 已配置部署：Issue 到 Draft PR 操作

此流程要求管理员事先配置修改、测试和发布权限，不属于 setup 只读入口。

## 高级用法：Issue 到 Draft PR

把一个 GitHub Issue 交给已配置的 Sandcastle implementation 能力，它会在隔离分支中尝试实现、运行测试并创建 Draft PR。你得到的是待审查的 Draft PR，不是自动合并的改动。

目前没有网页 UI，也不能把 Issue URL 直接提交；服务不会自动拉取 Issue。每次使用前，管理员必须先部署并交付以下信息：

- 应用目录 `APP` 的绝对路径。
- 数据目录 `DATA` 的绝对路径；控制 socket 位于 `$DATA/control.sock`。
- 已登记目标仓库的 repo ID。
- `implementation` 能力、测试工具和 Draft PR 发布权限已配置并完成部署验收。
- 该仓库本地 checkout 中可访问的固定基线 commit SHA。拿不到这些信息或配置未就绪时，单靠复制本指南无法提交。

## 每次使用

以下命令在部署 Sandcastle 的 Linux 主机上运行，不是在任意电脑上运行。服务应已启动；终端需要 `git`、`gh`、`jq`、`pnpm`，且 `gh` 已登录具有目标 Issue 读取权限的账号。

### 第一步：选仓库和 Issue

先设置管理员交付的路径和 repo ID，并填写目标 Issue 编号：

```sh
export APP='/管理员交付的/app/绝对路径'
export DATA='/管理员交付的/data/绝对路径'
export REPO_ID='管理员交付的repo-id'
export GITHUB_REPO='OWNER/REPO'
export ISSUE=123
```

`APP` 指 Sandcastle 应用目录，`DATA` 指其运行数据目录，`REPO_ID` 是管理员在服务配置中登记的 ID；`GITHUB_REPO` 是 Issue 所属 GitHub 仓库，必须与该登记 repo 对应。`ISSUE` 是正整数 Issue 编号，不是 PR 编号。

### 第二步：读取 Issue 内容

从 GitHub 读取目标 Issue 正文；这一步只读 GitHub，不会提交任务：

```sh
ISSUE_BODY="$(gh issue view "$ISSUE" --repo "$GITHUB_REPO" --json body --jq .body)"
test -n "$ISSUE_BODY" || { echo 'Issue 正文为空或读取失败' >&2; exit 1; }
```

### 第三步：选择从哪个代码版本开始

从目标仓库的本地 checkout 读取管理员指定的完整基线 SHA。下面的 `CHECKOUT` 必须是目标项目仓库，不是 `$APP`：

```sh
export CHECKOUT='/目标项目仓库的本地checkout绝对路径'
SHA="$(git -C "$CHECKOUT" rev-parse 'BASE_REF^{commit}')"
test "$(printf %s "$SHA" | wc -c | tr -d ' ')" -eq 40 || { echo '需要完整的40位commit SHA' >&2; exit 1; }
git -C "$CHECKOUT" cat-file -e "$SHA^{commit}"
```

把 `BASE_REF` 换成管理员交付的固定分支或 commit 引用。`SHA` 必须属于 `CHECKOUT` 对应的目标仓库、完整且已在其本地对象库中；编排器不会替你 fetch。若对象不存在，先请管理员确认基线和 checkout，不要用 Sandcastle 应用仓库的 SHA 代替。

### 第四步：提交任务

下面把代码版本、Issue 编号和正文打包为 JSON，再提交。`jq` 会处理正文中的引号和换行，不需要手动转义。CLI 会输出一行 JSON 回执：

```sh
INPUT="$(jq -n --arg sha "$SHA" --argjson issue "$ISSUE" --arg issueBody "$ISSUE_BODY" \
  '{sha:$sha,issue:$issue,issueBody:$issueBody}')"
REPLY="$(sandcastle-orchestrator submit \
  --socket "$DATA/control.sock" --repo "$REPO_ID" \
  --capability implementation --source manual --input "$INPUT")"
printf '%s\n' "$REPLY" | jq .
```

### 第五步：保存任务编号，查看进度

确认回执为接纳状态并保存 `executionId`。拒绝回执会有 `accepted:false` 和原因；接纳回执中的 `executionId` 才用于查询：

```sh
printf '%s\n' "$REPLY" | jq -e '.accepted == true and (.executionId | type == "string")' >/dev/null || {
  echo '请求未接纳；查看上方 JSON 回执及 reason' >&2
  exit 1
}
EXECUTION_ID="$(printf '%s\n' "$REPLY" | jq -r .executionId)"
printf 'executionId=%s\n' "$EXECUTION_ID"
sandcastle-orchestrator show "$EXECUTION_ID" --socket "$DATA/control.sock" | jq .
```

`show` 返回的状态在 `.execution.status`；最近一次尝试在 `.attempts[-1]`。先等待队列处理，不要因为尚未完成就重复提交。以下字段结构是示意，不是真人实测输出：

```json
{
  "execution": { "id": "<executionId>", "status": "completed" },
  "attempts": [{
    "kind": "agent",
    "contract": "valid",
    "business": "模型生成的业务报告",
    "toolCalls": [{
      "id": "1",
      "runState": "completed",
      "receipt": {
        "draft": true,
        "url": "https://github.com/OWNER/REPO/pull/123"
      }
    }]
  }]
}
```

实际报告字段以当前记录为准：业务报告通常位于 `.attempts[-1].business`；发布结果在含 `publish_draft` 的工具调用下，成功回执包含 `receipt.url` 与 `receipt.draft`。`completed` 只表示记录的执行入口结束，仍要核对 `contract`、报告和发布回执；只有 Draft PR 链接存在且 `draft` 为 `true` 才进入 PR 审查。

### 第六步：打开并审查 Draft PR

审查 Draft PR 中的改动、测试证据和报告。Sandcastle 不会自动 merge；是否修改、批准或合并由仓库维护流程决定。

## 常见状态

- `queued`：已接纳并排队，尚未开始；可稍后再次 `show` 查询。
- `starting` / `running`：正在准备或运行；等待后再查询，不要重复提交。
- `completed`：入口已结束；检查业务报告、测试结果和 Draft PR 回执，不能只凭此状态判断任务成功。
- `unknown`：执行或外部结果未能确定。停止继续提交和 retry，保留 `executionId` 并联系管理员核查；盲目重试可能重复外部写入。
- 未知状态、拒绝原因不明、服务不可用或没有 Draft 链接：把 `executionId` 与回执交给管理员，不要自行盲目 retry。

管理员负责配置和恢复；需要首次部署、授权边界、故障核查或备份恢复时，请看[部署与运维指南](deployment-guide.md)。

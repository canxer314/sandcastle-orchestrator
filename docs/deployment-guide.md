# Sandcastle 部署与运维指南

本指南面向部署管理员，保留从本地练习、接入仓库、配置 Agent/工具到故障恢复的操作细节。普通使用者请先看[用户指南](user-guide.md)；配置与远端写入须由管理员按授权范围完成。

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

这两者是管理员配置的能力组合，不是多写一个 capability 名称就能工作。先读 `examples/implementation.ts`、`examples/pr-analysis.ts` 以及 README 对应章节，按部署约束把增量合入可信配置。

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

进一步的提交字段、状态含义、备份恢复、日志/产物限制见 [README](../README.md)；旧管理命令默认输出 JSON，显式 `--human` 提供可读结果；init/doctor/demo/setup 默认可读，支持 `--json`。退出码和不确定回执见[提交指南](submissions.md)，不能仅看退出码判断受理或业务成功。妥善保护输入、配置、报告和日志，其中可能包含敏感数据。

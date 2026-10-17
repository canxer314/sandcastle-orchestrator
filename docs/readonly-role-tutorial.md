# 自定义角色、能力与外部提交

首次使用请完成[主教程](user-guide.md)。本页供需要自定义业务报告或工具的配置维护者查阅，不是首次分析的前置步骤。

本教程从包外可信配置开始，新增 `repository-question` role，在获准的小型 Git 仓库的固定 commit 上回答问题，再查询本地报告。完整文件是 [config.ts](../examples/readonly-role/config.ts)，可选组合在 [composition.ts](../examples/readonly-role/composition.ts)。它们只 import 正式包和已安装依赖，不依赖内部源码。

## 1. 准备独立资源和执行条件

需要 Linux、Node.js 24+、npm、Git、util-linux `flock`，以及已安装的正式 CLI。先按[安装说明](installation.md)安装。下面需本地 tgz 的配置示例可使用同版本 Release 附件。安装消费者不需要源码或 pnpm。下面以同一份已验收 tgz 为配置依赖，不能用全局 CLI 的 node_modules 代替配置自己的依赖。

真实运行还要求管理员准备并授权以下资源。缺一项就先停在类型检查，不要把配置加载成功当成模型连接成功。

- 本机 Docker daemon，且当前用户已有使用权限。不会自动安装、提权或拉镜像。
- 已预部署的可信镜像，含 POSIX `sh`、`env`、Git、Node.js 和可用的原版 Claude Code CLI。记下镜像 digest 与容器 CLI 版本。不要把仅有 Node 的测试镜像当作 Agent 镜像。镜像准备可参考[真实分析教程](user-guide.md)，但仍须核对本部署的版本与权限。
- 用户明确授权读取的独立 settings JSON，或明确选择复用的 live settings JSON，路径为绝对路径。它必须提供当前连接投影支持的静态 client-facing API key 或 Bearer token，且恰好一个有效。不要把值写进教程文件、任务输入或报告。复用不意味着复制整个 home、hooks、插件、MCP、permissions、CC-Switch 数据库或订阅登录。
- 容器可达的 Anthropic Messages-compatible endpoint 与该 endpoint 接受的模型名。这是 Claude Code harness 的连接，不限定物理模型或上游认证来自 Anthropic。普通 Docker `bridge` 可出网；它不是 endpoint-only 隔离。本教程以容器直接可达 endpoint 为前提，不自行建立桥或修改私人代理 listener。执行桥设施仅在其支持条件下为 HTTP loopback 自动建立执行级桥，限制见[连接投影](user-guide.md#维护模型连接)；受控桥验证不替代真实 Docker/代理验收。不支持的 helper、OAuth、云凭据、代理或 TLS 依赖需要管理员另行处理，不能自动换身份或关闭 TLS 校验。

连接白名单、优先级、秘密过滤的限制见[连接投影](user-guide.md#维护模型连接)。本例使用公开依赖 `@ai-hero/sandcastle@0.12.0` 的 `claudeCode(model)`，显式要求模型名。包根提供支持省略模型的 `claudeCode()`，需要继承来源模型时可从正式包导入该函数，不导入内部源码、不复制适配器。本例保留显式选择，显式值会覆盖连接来源的模型；代理最终路由仍由代理决定。

选一个已获准、没有秘密的小仓库。不要把编排器源码当作默认目标，不要使用超出授权的数据。下面只读取现有 checkout，不 clone、fetch、commit、reset 或切分支。当前固定树导出不支持 symlink/submodule，仓库也不能提交 `.sandcastle/.env`。

```sh
set -eu
umask 077
export TGZ='/absolute/path/canxer314-sandcastle-orchestrator-0.1.0.tgz'
export CONFIG="$HOME/.config/sandcastle-readonly-tutorial"
export DATA="$HOME/.local/state/sandcastle-readonly-tutorial"
export TUTORIAL_REPO='/absolute/path/to/authorized-small-checkout'
export TUTORIAL_IMAGE='administrator-selected-local-image@sha256:REPLACE_WITH_ACTUAL_DIGEST'
export TUTORIAL_MODEL='administrator-selected-backend-model'
export TUTORIAL_CONNECTION='/absolute/path/to/explicitly-authorized-settings.json'
export TUTORIAL_CONFIG_VERSION='replace-with-deployed-configuration-commit'

sandcastle-orchestrator --version
sandcastle-orchestrator serve --help
git -C "$TUTORIAL_REPO" rev-parse --show-toplevel
SHA="$(git -C "$TUTORIAL_REPO" rev-parse --verify 'HEAD^{commit}')"
printf '%s\n' "$SHA" | grep -Eq '^([a-f0-9]{40}|[a-f0-9]{64})$'
git -C "$TUTORIAL_REPO" cat-file -e "$SHA^{commit}"
git -C "$TUTORIAL_REPO" status --short
export SHA
```

替换所有占位值再运行。未提交的修改不会进入选定 SHA；`status` 只是提示，不会提交或清理。`TUTORIAL_CONFIG_VERSION` 是可信配置的部署版本，不是目标代码的 SHA。

配置、安装根、data 和业务 checkout 必须互不包含，symlink 的物理路径也不能重合。使用全新的配置和 data，不能借教程接管已有实例。下面 `mkdir` 遇到已有目录就停止；先检查现场并选新路径，不删除旧配置或证据。

```sh
mkdir -p "$(dirname "$CONFIG")" "$(dirname "$DATA")"
mkdir -m 700 "$CONFIG" "$DATA"
printf '%s\n' '{"private":true,"type":"module"}' > "$CONFIG/package.json"
npm --prefix "$CONFIG" install "$TGZ" @ai-hero/sandcastle@0.12.0 zod@4.6.5
npm --prefix "$CONFIG" install --save-dev typescript@5.9.3 @types/node@24.19.1
```

将本教程链接的完整 `config.ts` 保存到新的 `$CONFIG/config.ts`。若已持有维护者提供的示例文件，可用下面命令复制，`cp -i` 在目标已存在时询问，不覆盖已有内容。文件可以从网页下载，不要求用户 clone 编排器。

```sh
cp -i /absolute/path/to/provided/readonly-role/config.ts "$CONFIG/config.ts"
"$CONFIG/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck \
  --module NodeNext --target ES2023 "$CONFIG/config.ts"
```

TypeScript 是可信宿主代码。`serve` 加载配置及其 import 时可以读写宿主文件、执行命令和访问网络，配置校验不是沙箱。`tsc` 只做类型检查，不证明 Docker、认证、endpoint 或模型路由成功。不要为诊断把 settings、环境或含凭据堆栈贴进日志。

## 2. 看懂 role 与 binding

完整配置中的 role 只定义业务职责。

| 字段 | 本例行为 |
| --- | --- |
| `validate` | 严格检查 `{sha, question}`，接受完整 40/64 位小写 SHA，拒绝空白问题和额外字段。校验返回值不会改写持久化输入。 |
| `buildPrompt` | 把用户问题和设施解析的 `actualSha` 放进 prompt，请求引用文件和行号，不运行项目脚本、测试或后续任务。 |
| `skills` | 追加普通文本方法指导，要求区分观察、推断和缺失证据。这里不是宿主技能目录或自动安装机制。 |
| `tools` | 基础例为 `[]`，不提供编排器测试、修改或发布工具。它不关闭 harness 原生工具。 |
| `validateReport` | 解析 JSON，校验 `summary`、非空 `evidence` 和 `limitations`。格式合法不代表引用真实或答案正确，仍须人工核对。 |

provider 决定如何启动和解析 harness，environment 决定镜像、网络及设施，`roleBindings` 把 role、provider、environment 连起来，并用 `commit(input)` 选固定 SHA。role 不绑定某一个模型，改 provider 不应改变业务报告含义。repo ID `tutorial` 是登记标识，不是路径；CLI 仍用 `--capability repository-question` 选择 role，没有另一个 `--role` 参数。

不设置 `workspace:'implementation'` 就使用现有只读 role 工作区。设施在 data 中生成独立工作副本，把仓库及 Git metadata 只读挂载，容器 rootfs 只读，但 `/tmp`、临时 HOME 和 harness 原生 shell/工具仍可能写临时内容。服务也会写记录、报告和日志。不能声称“无 shell”“所有文件不可写”或“完全无副作用”。prompt 的禁令是业务约束，不是对任意 shell 操作的技术证明；只读挂载也不是网络隔离或通用数据防泄漏。

本例没有 `repo.publication`、publication tool、发布凭据、测试 capability 或 implementation 工作区。不要为了让例子运行而添加这些权限。

## 3. 显式启动服务，提交一个问题

在设置了上述环境变量的终端启动服务，并保持该终端运行。

```sh
sandcastle-orchestrator serve --config "$CONFIG/config.ts" --data "$DATA"
```

stdout 的 `{ "ready": true, ... }` 只表示控制服务就绪。日志在 stderr。没有自动后台服务，也没有自动提交。另开终端时重新设置相同的 `DATA`、`TUTORIAL_REPO`，再选定和核对 SHA；不要依赖另一终端未导出的 shell 变量。

```sh
set -eu
export DATA="$HOME/.local/state/sandcastle-readonly-tutorial"
export TUTORIAL_REPO='/absolute/path/to/authorized-small-checkout'
SHA="$(git -C "$TUTORIAL_REPO" rev-parse --verify 'HEAD^{commit}')"
printf '%s\n' "$SHA" | grep -Eq '^([a-f0-9]{40}|[a-f0-9]{64})$'
git -C "$TUTORIAL_REPO" cat-file -e "$SHA^{commit}"
INPUT="$(node -e 'console.log(JSON.stringify({sha:process.argv[1],question:process.argv[2]}))' \
  "$SHA" '说明这个项目的主要模块及调用关系，给出可核对的文件引用。')"
sandcastle-orchestrator submit --socket "$DATA/control.sock" \
  --repo tutorial --capability repository-question \
  --input "$INPUT" --source readonly-tutorial
```

保存实际回执的 `requestId` 和 `executionId`。`accepted:true` 只代表受理，提交是异步的；默认 JSON 下即使 `accepted:false` 也可能 exit 0，不能只看进程退出码。source 是追踪字段，不是认证身份。回执丢失时先查当前实例 `list` 和已知记录，不自动重发。本教程保持 `--input` 和显式 socket 的基础调用；已合入的文件输入、人类可读回执及 source/key 核对另见[提交指南](queries.md#提交任务并保留回执)和[查询指南](queries.md)，不是运行本示例的前提。

## 4. 查询执行和本地报告

将 `EXECUTION_ID` 换成回执里的真实编号。每条管理命令显式带相同 socket，不加载配置或自动启动服务。

```sh
export DATA="$HOME/.local/state/sandcastle-readonly-tutorial"
export EXECUTION_ID='replace-with-actual-execution-id'
sandcastle-orchestrator list --socket "$DATA/control.sock" --repo tutorial
sandcastle-orchestrator show "$EXECUTION_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator logs "$EXECUTION_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator artifact "$EXECUTION_ID" --socket "$DATA/control.sock" --name report.txt
```

`show` 的 `attempts` 中查看实际 `actualSha`、`workspaceMode`、`runState`、`exitCode`、`contract`、`business`、`stopConfirmation`。查询可以重复，不自动 wait 或 retry。先确认最新 attempt 是你要看的那个；多次尝试可用已有 `--attempt ATTEMPT_ID` 查询对应日志或产物。

- `completed` 表示执行有结束记录，不表示问题答对或测试通过。
- `contract:'valid'` 只表示模型报告通过本例 schema；`contract:'error'` 仍可能有原始 `report.txt`。按固定 SHA 人工检查引用与答案。
- `business` 是校验后的报告。大报告可能以 `businessReference` 指向 `business.json`，用 `artifact --name business.json` 读取。
- `unknown` 表示结果或结束证据缺口，不能当失败后盲目重跑。`cancel` 回执和控制服务退出都不能证明 Agent、工具或远端工作停止。按[运维指南](deployment-guide.md)核对、确认停止和人工恢复，不删库或强杀来制造成功。
- 本 role 不执行测试，没有“测试通过”的证据。模型自述跑过测试也不算测试结果。

`artifact` 返回 JSON，内容为 base64。先检查 `availability:'available'` 和 `encoding:'base64'` 再解码。下面只打印报告，不执行报告文本。

```sh
sandcastle-orchestrator artifact "$EXECUTION_ID" --socket "$DATA/control.sock" --name report.txt |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);if(r.availability!=="available"||r.encoding!=="base64"||typeof r.content!=="string")throw Error("Report unavailable; inspect show/logs");process.stdout.write(Buffer.from(r.content,"base64"));});'
```

默认产物读取上限是 8 MiB；更大的报告用同一命令加 `--offset 0`，按 `nextOffset` 逐块读取，直到 `complete:true`，不要把首块当完整报告。日志只返回末尾最多 64 KiB，检查 `truncated` 与 `complete`；缺失或清理后的证据不是空报告或成功。

停止服务前先核对所有执行及工具。服务终端的 Ctrl+C 不是任务停止保证；不要直接据此清理 data、容器或凭据。保留证据，按[管理员参考](deployment-guide.md#维护窗口备份与恢复)操作。

## 5. 用现有能力组合任务

Agent role 让模型决定怎样阅读和解释证据。确定性 capability 由可信配置的 `run(context)` 执行固定程序，记录退出和业务结果，不需要模型。工具是 role 可调用的已登记入口，不是全局权限。业务方法放 role 或 capability，不写进 scheduler。

[composition.ts](../examples/readonly-role/composition.ts) 是在同一基础配置上可选的完整增量。它增加 `list-root` capability，用镜像里的 Node 列出 `/workspace` 根目录，既不执行项目脚本，也不测试或发布。它可独立提交，也可经 `list_root` 工具提供给 role。配置自身仍在宿主执行；只有 `context.exec` 的命令走受控 Docker 设施。

先保存 `composition.ts` 到 `$CONFIG/composition.ts` 并类型检查。要启用它，先按维护流程核对并停止你原有服务，再用同一环境变量启动这个配置，不要与旧服务争抢 data。

```sh
cp -i /absolute/path/to/provided/readonly-role/composition.ts "$CONFIG/composition.ts"
"$CONFIG/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck \
  --module NodeNext --target ES2023 "$CONFIG/config.ts" "$CONFIG/composition.ts"
sandcastle-orchestrator serve --config "$CONFIG/composition.ts" --data "$DATA"
```

另一个终端可先独立提交目录观察，再人工决定是否提交问题。

```sh
INPUT_SHA="$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$SHA")"
sandcastle-orchestrator submit --socket "$DATA/control.sock" \
  --repo tutorial --capability list-root --input "$INPUT_SHA" --source readonly-tutorial
# 用此回执自己的 executionId 执行 show。确认结果后，才由你决定是否提交 repository-question。
```

两次提交是独立 execution，不自动传递报告、不建立依赖，也没有条件分支。不要把这个手动顺序叫自动 workflow。独立提交 `list-root` 的输入是 JSON SHA 字符串。不要独立提交 `{}`，它虽然通过共用 validator，但没有可独立选定的 SHA，会在执行准备时报错，受理不等于可执行。

role 通过工具调用时，输入是 `{}`，设施把当前 repo、attempt 和 `actualSha` 绑定到调用，不让模型选择可信身份或凭据。capability 的 validator 因而接受完整 SHA 或严格空对象；独立入口仍由 `execution.commit` 要求 SHA。`execution.workspace:'readonly'` 是现有 executable tool 的必要声明，工具实际执行仍禁网。`configureClaudeMcp` 来自正式公开导出，配合 `mcp:'claude-code'` 将入口交给 harness 原生 MCP。镜像里的 CLI 必须支持这一方式，配置通过不证明实际工具调用成功。`show.attempts[].toolCalls` 以及 `logs --call CALL_ID` 可核对调用证据；缺失调用不能用模型文字补成已执行。

复用工具时，在新 role 的 `tools` 中显式引用已登记 ID。新增简单只读数据源可以实现 `Configuration.tools[].read(input)`，按现有 `createPrSnapshotTool` 的模式限制输入、资源范围、读取大小和来源，失败就报告证据不可用。它在宿主执行，需要管理员审查，名字叫只读不保证实现真的只读。需要可审计执行时，把固定命令放进 capability，再用严格 `inputSchema` 绑定工具；不要把用户文本拼进 shell。外部 MCP 使用已有 `mcpServices`、role 的 `mcp` 引用及 provider 的 `configureMcp`，代码上下文须绑定 repo 和实际 SHA，不能伪造 context 或停止保证。

已有 implementation + test tool + Draft PR 发布流程和 PR snapshot analysis 仍按各自指南与授权运行。不要将它们合进最小只读 role。PR analysis 示例要求的 endpoint-only 网络应由部署环境实现；普通 bridge 不提供该隔离保证。

## 高级配置的类型与运行时 import

全局 CLI 的依赖不自动成为外部配置的依赖。需要 value import 的配置，请在配置目录建立自己的 ESM 项目，并安装它实际 import 的包；不要设置 NODE_PATH 或导入本仓库的内部源码。

在新的配置目录中准备依赖：

```sh
cd "$CONFIG"
# package.json 已包含 "private": true 和 "type": "module"
npm install @canxer314/sandcastle-orchestrator@0.1.0 zod@4.6.5
npm install --save-dev typescript@5.9.3 @types/node@24
```

公开类型包括 `Configuration`、`ExecutionContext`、`Submission`、`Role` 和 `McpCapability/McpService/McpReference/McpConnection`。运行时导出包括 `configureClaudeMcp`、`createPrAnalysisRole` 和 `createPrSnapshotTool`。以下完整配置只验证加载与定义，不绑定 provider，不调用模型、不读取 snapshot：

```ts
import type { Configuration } from '@canxer314/sandcastle-orchestrator';
import { createPrAnalysisRole, createPrSnapshotTool } from '@canxer314/sandcastle-orchestrator';
import { z } from 'zod';

const scope = { repo: 'owner/example', pullRequests: [31] };
export default {
  version: 'replace-with-deployed-config-commit',
  repos: [{ id: 'example', location: '/absolute/path/to/your/checkout' }],
  environments: [{ id: 'local' }],
  roles: [createPrAnalysisRole(scope)],
  tools: [createPrSnapshotTool({ ...scope, path: '/absolute/path/to/authorized-prs.json' })],
  capabilities: [{
    id: 'accept-only', environment: 'local',
    validate(input: unknown) { z.string().parse(input); },
    run(context) { return { business: context.input }; },
  }],
} satisfies Configuration;
```

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --module NodeNext --target ES2023 config.ts
sandcastle-orchestrator serve --config "$CONFIG/config.ts" --data "$DATA"
```

provider 扩展继续通过 `Configuration.providers` 使用现有 `AgentProvider` 契约；如果配置 import `@ai-hero/sandcastle` 的 provider，需在配置项目显式安装兼容版本 `@ai-hero/sandcastle@0.12.0`。MCP helper 只在对应 harness 支持时使用，不改变 provider 选择或连接。高级 execution、role binding、镜像与授权策略仍由管理员准备；只读问答可由显式 `setup` 生成参考配置，但不会自动执行。

排障时先检查 `node --version`、配置目录的 `package.json`、自身 `node_modules`、文件名和相对 import 路径。`Cannot find package`/TS2307 通常表示配置自己的依赖未装，不能靠全局 CLI 的 node_modules 解决。`service_failure` 故意不输出任意配置异常和堆栈，防止凭据泄漏；先对配置运行上述类型检查，再在受控环境检查可信配置的 import 和定义。不要把环境变量、token 或含凭据的堆栈贴到日志/Issue。`separate` 错误需要调整目录布局，不能删除锁或绕过真实路径检查。

## 新增不调用模型的测试能力

下面用独立的源码 checkout 保存配置示例并演示完整测试能力，需要 pnpm 12.3.4 和已安装的正式 CLI。已安装用户也可在配置项目中从公开包导入 `Configuration`，不依赖源码 import。应用、配置、data 和练习仓库不能互相包含。

### 准备四个互不包含的目录

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

### 建立带测试脚本的练习仓库

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

### 写可信配置

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

### 在终端 A 启动服务

在终端 A 设置同样的路径变量（新终端不会继承上一段 shell 的局部变量），然后启动：

```sh
export APP="$HOME/sandcastle-orchestrator"
export CONFIG_DIR="$HOME/sandcastle-demo-config"
export DATA="$HOME/sandcastle-demo-data"
export REPO="$HOME/sandcastle-demo-repo"
cd "$APP"
sandcastle-orchestrator serve --data "$DATA" --config "$CONFIG_DIR/config.ts"
```

前台保持运行。就绪时输出 JSON，含 `"ready":true` 和 socket 路径。服务会独占数据目录锁；`flock` 不可用或目录与配置/checkout 不分离时应先解决启动错误，不要删除 lock 文件绕过。

### 在终端 B 提交、查询、看日志

另开终端 B，重新设置变量。`sandcastle-orchestrator` 直接执行 CLI，不经 `pnpm start` 的脚本 banner；回执为纯 JSON。下面要求 `jq`，先检查依赖，再验证接纳状态并自动保存两个 ID：

```sh
command -v jq >/dev/null || { echo '请先安装 jq' >&2; exit 1; }
export APP="$HOME/sandcastle-orchestrator"
export DATA="$HOME/sandcastle-demo-data"
export REPO="$HOME/sandcastle-demo-repo"
cd "$APP"
COMMIT="$(git -C "$REPO" rev-parse HEAD)"
REPLY="$(sandcastle-orchestrator submit --socket "$DATA/control.sock" \
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
sandcastle-orchestrator show "$REQUEST_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator show "$EXECUTION_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator logs "$EXECUTION_ID" --socket "$DATA/control.sock"
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
REPLY="$(sandcastle-orchestrator submit --socket "$DATA/control.sock" \
  --repo demo --capability test-commit --source manual \
  --input "\"$FAILED_COMMIT\"")"
printf '%s\n' "$REPLY" | jq -e '.accepted == true' >/dev/null || { echo 'failure test submission rejected' >&2; exit 1; }
FAILED_ID="$(printf '%s\n' "$REPLY" | jq -r .executionId)"
sandcastle-orchestrator show "$FAILED_ID" --socket "$DATA/control.sock"
```

失败尝试预期仍可能是 `completed`、`contract: valid`，但 `business.passed` 为 `false`、`exitCode` 非零。练习后若要恢复成功脚本，修改文件并另建恢复 commit；之后提交新 SHA。

停服务前先停止新接纳和新启动。在终端 B 执行维护暂停，再确认所有执行都已可信结束；有 `running`、`starting`、`unknown` 或未决工具调用时，不要退出终端 A，应先按[取消与恢复](queries.md#取消执行并人工恢复)核查。暂停不停止已有任务。

```sh
sandcastle-orchestrator pause --socket "$DATA/control.sock" --target all \
  --source operator --reason '本地练习结束前暂停'
sandcastle-orchestrator list --socket "$DATA/control.sock" --repo demo
# 对每个 executionId 执行 show；确认没有运行中/未决 attempt 后，才可在终端 A 按 Ctrl-C。
```

Ctrl-C 仅请求控制服务退出，不是停止任务的手段，也不证明 harness/container 已停。若本地练习仍有执行，先等可信结束或按恢复流程处理；不要强杀进程或容器。

## 确定性执行

管理员能力 `run(context)` 直接使用 `context.exec(argv)` 调用容器脚本，不需要 Agent、模型或 MCP。业务判断留在能力内，返回 `{ business: 任意可 JSON 保存的值, artifacts?: string[] }`；这只是入口结束契约，不要求脚本输出业务 JSON。脚本非零 exit code 正常返回，由能力解释测试失败。`context` 提供原始输入、`attemptId`、`actualSha`，脚本工作目录 `/workspace`，产物写入 `/artifacts`。一次尝试内必须逐次 await 脚本；入口提前返回时保持 unknown，晚到输出不会改写终态。返回值经 JSON roundtrip 验证，不能使用被 JSON 省略的 undefined/function/symbol 作为 business。没有编排器并发限制或通用 worker/timeout。具体脚本负责自己的超时行为。

启动前先事务保存尝试、当前配置版本、能力与环境标识，再保存实际 SHA、独立目录与容器标识。任何必要保存失败都不启动脚本；接纳回执只证明提交已保存，不承诺启动成功。SQLite 与进程启动不是原子事务。每个尝试从登记的本地 repo 导出固定完整 SHA 的 blobs，目录位于 `DATA/attempts/ATTEMPT_ID/workspace`，没有 `.git`、remote、未提交文件或 checkout hooks。导出使用 Git `ls-tree`/`cat-file`，不执行 archive exporter；禁用全局/系统 Git 配置、fsmonitor、replace objects 和 partial-clone lazy fetch。当前拒绝 symlink/submodule，不隐式拉取外部代码。每个 blob 上限 64 MiB。

薄 Docker adapter 固定 `--pull=never --network none --cap-drop ALL --security-opt no-new-privileges --read-only`，以控制服务 UID/GID 运行，只有该尝试代码与产物目录可写挂载以及隔离 `/tmp`。不注入宿主环境、凭据、原 repo Git 目录、home 或 Docker socket；镜像/daemon/入口启动失败不回退宿主。Sandcastle 0.12 的 public Docker API 已核对，但其默认挂载 worktree 与原 Git 目录，不能满足此处无推送权限边界，因此这里直接调用 Docker CLI。管理员必须预部署无生产凭据、无敏感文件、适合该 UID 的可信镜像，建议固定 digest；本应用不会清洗镜像。无网络不等于完整安全隔离，Docker daemon/内核漏洞、资源耗尽、代码中已有秘密仍需部署边界防护。

```sh
sandcastle-orchestrator logs REQUEST_OR_EXECUTION_ID --socket /srv/orchestrator-data/control.sock
sandcastle-orchestrator artifact REQUEST_OR_EXECUTION_ID --name result.txt --socket /srv/orchestrator-data/control.sock
# 多个尝试时可明确选择；默认读取最后一次
sandcastle-orchestrator logs EXECUTION_ID --attempt ATTEMPT_ID --socket /srv/orchestrator-data/control.sock
```

`logs` 返回 stdout/stderr 最后 64 KiB、`truncated`、`complete` 与 attempt/SHA；不存在的流返回 `null`，未完整结束不宣称日志完整。原始流随运行写入权限受限的文件；`exec` 返回每流最后 64 KiB。产物必须是 `/artifacts` 内单层普通文件，名称仅字母数字、`.`、`_`、`-`，不跟随 symlink，单个读取上限 8 MiB。引用绑定 attempt 与实际 SHA，CLI 以 base64 读取。日志与产物不做秘密过滤，不要让脚本输出秘密。

状态 `starting`/`running` 表示本控制实例的进展，`completed` 表示入口结束已保存；`contract: valid/error` 与 `business` 分开，测试失败可正常完成。`start_failed` 表示明确启动失败，`unknown` 表示事实/保存未决，需人工核查。结束保存失败在当前查询显示 `persistenceError`，持久化状态仍保留原值；重启后原 `starting/running` 投影为 `unknown`，包含 `persistedRunState` 与 `requiresAttention`，不虚报完成或自动重跑。控制服务中断或 Docker client close 不保证容器已停止；每次命令保留容器，inspect 的 `State.Running/Status/ExitCode` 才是可信结束证据，证据缺失或仍在运行保持 unknown，脚本真实退出 125/126/127 也可以正常完成。确认结束后能力解析失败记录 completed + contract:error。尝试保留容器名与结束证据用于人工核查。容器不自动删除（包括已结束容器），需要管理员依据记录确认停止后定期清理，不能把 client 退出视为停止证明；容器需管理员核查后清理，日志与产物的到期清理见[部署维护](deployment-guide.md#到期清理)。

## 配置角色运行设施

可选 `roles` 定义业务身份：`id`、`description`、`validate(input)`、`buildPrompt({input,repo,actualSha})`、`skills: string[]`、`tools: string[]`、`validateReport(report)`。工具 ID 引用可选 `tools: [{id,description}]` 中的已部署工具说明，不另建通用工具框架。`providers: [{id,agent}]` 接受公开 Sandcastle `AgentProvider`；`roleBindings: [{role,provider,environment,commit(input)}]` 将角色绑定 provider/环境与完整 SHA selector。同一角色可提交到不同登记 repo，用现有 `--capability ROLE_ID`，没有 binding 的角色只接纳排队。角色和确定性 capability ID 不可重名，旧配置无需新增字段。

角色 Prompt、skills/tool 说明、配置版本、provider/environment 身份与固定 SHA 在模型启动前必要保存，配置不热更新。输出格式由角色负责：`validateReport(output: string)` 接收真实文本，可直接返回文本或自行解析 JSON，并返回可 JSON 保存的业务报告；抛错表示返回契约错误。运行 error/exit code 与报告契约分别保存，非零退出的有效报告不会被丢弃。`show` 保存输出、迭代/session 引用、exit code、报告与契约状态；正常 CLI 退出不代表业务成功，不把建议转为请求。每次 retry 新目录、新 `orch/ATTEMPT_ID` branch、新 session，不 resume/fork。session 导出通过 `docker exec -i CONTAINER cat -- PATH` 流式写入宿主文件，兼容 `/home/agent` tmpfs，不依赖无法读取该挂载内容的 `docker cp`；文件导出不使用 8 MiB 命令缓冲，非零退出或宿主写入失败仍按 session capture 失败记录。

只读报告设施从本地 repo 创建独立无 remote clone，拒绝 symlink/submodule 与目标树 `.sandcastle/.env`；不挂载原 checkout、宿主 home、Docker socket或凭据。public `createSandbox` 创建专用 worktree，薄 `createBindMountSandboxProvider` 将代码/Git metadata 全部 readonly 挂载，root filesystem readonly，只有隔离 `/tmp`、`/home/agent` tmpfs 可写；Git setup 写隔离 home 的 global config，repo保持只读。管理员配置可信预部署 `docker.image` 与可选 `docker.env`、`docker.network`（默认 none，不允许 host）。未选择 `connection` 时，模型认证仍由管理员在环境中明确提供，不自动注入宿主环境或 GitHub 写凭据；provider 的 `agent.env` 不自动注入长生命周期 Sandbox。旧路径不保存环境快照，但不保证日志/模型输出秘密过滤。

不使用内置 SDK Docker provider：0.12.0 的 shutdown hook 在 exit/SIGINT/SIGTERM 调用 `docker rm -f`，没有公开 opt-out，违反未知状态不强杀。这里不注册这种 hook、不调用 SDK close/abort、不自动清理容器。管理员须在核查结束后清理保留容器。角色取消先保存协作意图，再向仅本 attempt 的目录发布 stop 文件，readonly 挂载 `/orchestrator-stop/requested`，Prompt 要求定期检查并及时返回；通知失败及必要保存失败可查询，不 close/kill，也不保证 Agent一定响应。原运行得到 CLI exit evidence 后可保存 cancelled。未知状态仍须人工确认停止后恢复。

`Sandbox.run` resolve 与模型文本都不能证明退出。公开 provider command 外包 subshell，在 CLI 实际结束后写随机 exit marker，stream parser 精确识别该 marker，保留原 stdin/parser/session 契约；marker 缺失保持 unknown。该证据用于可信设施中的生命周期观察，不是抵抗恶意容器/模型伪造的安全认证。显式 `idleTimeoutSeconds: Infinity`、`completionTimeoutSeconds: Infinity`、`completionSignal: []`，不增加 token/费用/turn 预算。Git setup/commit collection 沿用 SDK 10s/30s 真实设施超时；Docker启动与管理员工具各自负责超时，编排器不强杀。

连接来源、模型继承、支持字段和执行桥按[模型连接维护](user-guide.md#维护模型连接)配置。未配置 connection 的旧 provider 保持原行为。

### 设置协作停止与执行期限

`roleBindings` 可选 `attemptDeadlineSeconds`（有限正数，支持小数秒）；省略时无期限，仅适用于主 Agent 角色，不影响确定性执行。尝试进入 `starting` 时一并保存期限秒数、`createdAt` 和绝对 `deadlineAt`，包含准备与启动时间，不计排队。到期先保存 `cancellation.kind: deadline`、原因和请求时间，再沿用取消通路发布只读停止文件；不延长期限、不暂停续跑、不自动重试。准备阶段收到停止意图则不启动 Agent，保存 `never-started` 证据。

停止文件保留 `requested` 首行并增加 attempt/execution 身份、原因、请求时间及可读说明。Prompt 让 Agent 自主选择检查点，停止开展新工作、整理结果并正常结束，长工具调用可能延迟响应。`cancellationNotification: published/failed` 区分发送结果；published 不是结束证明。未配合、发送失败或保存未决继续保持 unknown，禁止替代尝试，后续调度必须继续计入主 Agent 额度。可信 CLI 退出后才记录实际取消终态；取消不证明子 Agent、工具或远端任务停止，也不撤销写入。

配置和 SQLite JSON 字段均为兼容性增加，原 CLI/socket 命令、旧记录及停止文件存在性检查保持有效。经恢复者核实并 resolve 的未决执行，其历史 `persistenceError` 保留为审计信息，不再单独阻止到期清理；未 resolve 的错误仍保护相关证据。回退到此前版本不会执行新增期限，需先停止服务并核查活跃尝试，再按[备份回退流程](deployment-guide.md#资源保留与手工换版)处理。

## 连接已有 MCP 服务

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

容器外 MCP 服务不继承只读容器隔离；服务及管理员落实目标目录、网络、身份与副作用限制，必要时显式配置环境网络。角色须区分业务结果、故障和未知，日志引用不可读时报告不可用，不把 URI 当已读证据。CLI exit marker 仅证明 Agent CLI 结束，不能证明 MCP 长任务停止。超时/断连后的外部结果及停止状态仍未知；取消只使用协作请求，不加统一远端取消、自动恢复、重试或补偿。原服务重试和副作用幂等限制必须在 `capabilities.retry` 写明，人工 retry 仍先核对外部结果。

## 分析管理员提供的 PR 快照

`examples/pr-analysis.ts` 提供普通角色、Prompt、Skill 和具体只读 `pr-snapshot` 工具；在可信部署配置中引用 `prAnalysis`，配置获准 GitHub repo/PR 白名单、快照路径、登记 checkout、固定 SHA selector、已授权 provider 和预部署镜像。没有分析调度模式，不要求报告 JSON，不固定收集/分类步骤。角色按需调用 `node /orchestrator-tools/call.mjs pr-snapshot '{"number":31}'`；工具不是只写在 Prompt 中的说明。

此工具采用管理员提供的离线证据，不联网采集或独立核验 GitHub。快照格式为 `{version,collectedAt,pullRequests:[{repo,number,url,updatedAt,headSha,body,reviews,diff,missing,truncated}]}`：时间为可解析日期，SHA 必须完整，正文/diff 为字符串，reviews 为数组，missing 为缺失内容名称数组，truncated 必须显式布尔值；文件须为普通非 symlink，最大 64 MiB。管理员负责来源授权和快照真实性；不要填凭据。工具只读部署时固定的路径，参数只接受白名单 PR number，不能选择任意文件、repo、命令或 GitHub API。每次观察返回 `source.kind: administrator-snapshot`、version、采集时间、完整快照 SHA-256、`verifiedAgainstGitHub:false` 与 PR 版本/SHA、缺失/截断线索。PR headSha 是快照所述版本，不冒充 checkout 的实际 SHA；后者仍由 Git 核对并绑定尝试。

可选 `tools[].read(input)` 是管理员部署的可信代码，不是函数名称保证只读。这个具体工具仅使用文件只读打开，不调用 shell、GitHub 或写 API。专属工具 Unix socket 仅开放当前角色绑定的工具，拒绝 64 KiB 以上请求及额外字段；不挂管理 socket、证据源目录、宿主凭据或生产写凭据。工具目录 readonly 挂载，socket `0600`，容器与控制服务使用相同 UID/GID。示例 `network:none` 默认 fail-closed，仅可使用受控离线 provider，不宣称真实模型可运行。该示例的 endpoint-only 网络要求须由部署环境实现；普通 Docker bridge 不提供该隔离保证。此工具不提供 GitHub 凭据、不回退宿主或 host 网络，也不建设网络配置平台。Docker UID/socket 连通性与实际模型连接须在授权环境验证。

```sh
sandcastle-orchestrator submit --socket /srv/orchestrator-data/control.sock --repo example \
  --capability pr-analysis --source manual \
  --input '{"sha":"0123456789012345678901234567890123456789","pullRequests":[31,32],"question":"哪些问题反复出现？"}'
sandcastle-orchestrator show EXECUTION_ID --socket /srv/orchestrator-data/control.sock
sandcastle-orchestrator artifact EXECUTION_ID --name observations.jsonl --socket /srv/orchestrator-data/control.sock
sandcastle-orchestrator artifact EXECUTION_ID --name report.txt --offset 0 --socket /srv/orchestrator-data/control.sock
```

工具观察独立写入每次尝试的 `observations.jsonl`，包含工具、参数、观察时间、attempt/实际 SHA、结果或故障；同一次尝试的观察记录逐条串行保存，避免并发大结果交错损坏 JSONL；工具读取仍可并发。每个调用的观察保存成功后才回复 Agent，失败不交付结果；失败追加会在同一串行队列内将同一已打开的普通文件回退到追加前长度，保留此前完整记录；回退成功后后续调用仍可保存独立可读的观察。若回退失败，该尝试的后续观察保存与结果交付均拒绝，不继续向可能损坏的 JSONL 追加；该尝试的证据缺口仍保留，`show.toolObservationError` 明示缺口。Agent 等待返回后，工具设施停止接纳新调用并等待已接纳的 handler（包括客户端已断开的调用）实际结束，再发布最终状态与业务结果；等待期间原始报告可读，但不发布完成或停止确认，不强杀或超时冒充工具结束。设施关闭不证明未知 Agent 已停止。任一工具观察保存失败后，即使 Agent 正常退出并返回限制说明，该尝试仍为 `unknown`，保留实际 `exitCode`/`stopConfirmation`、原始报告和来源引用，不发布 `business`、`businessReference` 或 `contract`；未核对处理前，即使超过 30 天也不清理其日志/报告。普通工具调用失败但故障观察成功保存时，仍可正常完成并报告限制。模型报告另存 `report.txt`，建议不自动变成修复、请求、评论或 Issue。旧尝试事实/报告不被 retry 或来源变化改写；重试可能得到新版本证据，其 digest/时间另行记录。报告应区分观察与推断，证据不足或工具故障应表达限制，不能把“没有证据”写成“没有问题”。

新角色输出与校验后的业务值各超过 64 KiB 时文件化：`output` 只保留不超过 65536 UTF-8 字节、不会拆开 Unicode 字符的预览，仅实际省略内容时设置 `outputTruncated:true`，完整模型文本见 `report` 引用；大的业务值不变类型或伪装为内联 `business`，改用显式 `businessReference` 指向 `business.json`（JSON 编码原校验返回值）。小报告的 `output/business` 与历史内联记录保持原形状。取消请求后的完成不发布 `business`、`businessReference` 或 `contract`；原始 `report.txt` 与工具观察仍可读取。`report.complete` 表示有 CLI 结束证据，`truncated:false` 表示保存的输出未裁剪，不保证业务证据充分。不存在输出不宣称有报告；文件缺失/非普通文件读取失败。

`artifact` 不带 offset 保持原 base64 响应和 8 MiB 上限；新增 `--offset`（socket 数字字段 `offset`）按字节读取至多 1 MiB，响应含 `offset,nextOffset,size,complete`。从 0 开始，依次以 nextOffset 读取至 complete，把每块 base64 解码后的字节拼接再按 UTF-8/JSON 解析；不要逐块解码文本以免拆开多字节字符。这样大报告/事实可以完整读取，`logs` 仍是明确标注截断的 64 KiB 尾部，不替代报告。新增 JSON facts/文件不改旧 SQLite schema，备份/回退必须包含完整 DATA；旧版本不能读取新分块协议，回退规则见[部署维护](deployment-guide.md#资源保留与手工换版)。

PR 分析的业务质量、真实模型与容器设施须在自己的授权部署中验证，不能借用其他角色的运行结果。

## 向角色提供当前尝试的测试工具

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

## 允许实现角色发布 Draft PR

`examples/implementation.ts` 是普通 Role/Prompt/Skill/tools 配置增量。管理员显式设置 `roleBindings[].workspace: 'implementation'`；旧角色默认 readonly 不变。SDK 原代码与 Git mounts 始终 readonly，容器内初始化独立 `/implementation` clone 与本尝试专用 `orch/ATTEMPT_ID` 分支，初始化退出证据保存后才开放 MCP/模型。宿主 SDK postprocessing 只处理原只读代码，SDK `commits` 不作为 implementation 提交证据。

实现角色调用既有 readonly capability 时，bound execute 的第一条内部命令在无网络容器收集当前 HEAD 与文件，第二条执行原 capability。两阶段共用串行命令、日志、Docker inspect 与 unknown 门禁。代码采集非原子，不保证原工作区瞬时一致；测试的是独立导出目录的实际 `revision.treeSha`。`actualSha` 是捕获 HEAD，dirty tree 不能冒充该 commit 已验证；`baseSha` 是原上下文。摘要、result.json、read_tool_file 和测试产物包含相同 revision。发现 symlink/submodule 拒绝；祖先目录竞态受容器可见范围约束，不声称全面阻止 symlink 竞态。宿主不读取或运行 implementation Git/config/filter/fsmonitor/hooks。

管理员为获准测试 repo 配置 `publication: {github:'OWNER/REPO',remote:'https://github.com/OWNER/REPO.git',base:'main',env:{...专用凭据}}`，并将 `{id:'publish_draft',description:'...',publication:true}` 绑定角色。写入设施只接受 `operation: publish|query`、既有测试 `callId`、title/body；repo/branch/base/凭据不可由模型选择。发布从独立导出 tree 在可信临时 Git 中构建 commit，以原 base 为 parent，核对 tree 与测试证据一致。发布 commit SHA 与采集 HEAD 分别保存。实际写入者查询远端 branch/PR，存在则拒绝替换，push 前再查 branch，普通单 ref push 后核对远端 SHA，再创建并核验 Draft PR。核查与 push 之间仍可能竞态，遵循普通 Git fast-forward/non-fast-forward 语义；不承诺服务端 create-only、分支锁或统一幂等。Git/gh 专用凭据仅在宿主 writer 环境，不注入模型或测试容器；部署需配置 Git HTTPS credential helper 或既有专用 Git 认证，不能用 unrestricted 模型凭据替代。

不提供 merge/force/comments/issues/settings/deploy 或任意写命令。响应丢失保存未知 publication，禁止再写，仅允许查询原 callId；查询 receipt 保存 branch SHA、PR 地址与 Draft/head/base 线索，不自动裁决未知结果。角色退出仍 unknown，恢复者须沿用 parent 与 tool 的 `confirm-stop → resolve/retry` 核对旧产物，retry 使用新分支，新需求/基线另建请求。不存在统一幂等、补偿或自动对账。

```sh
sandcastle-orchestrator submit --socket /srv/orchestrator-data/control.sock --repo approved-test \
  --capability implementation --source manual \
  --input '{"sha":"0123456789012345678901234567890123456789","issue":24,"issueBody":"管理员提供的获准 Issue 内容"}'
sandcastle-orchestrator show EXECUTION_ID --socket /srv/orchestrator-data/control.sock
```

配置、记录与协议为增量兼容，旧 readonly 与独立能力路径保留。样例运行不能证明一般实现任务质量，实际发布、响应丢失、取消和远端结果必须在自己的授权部署中核验。

## 配置发布与快照分析的授权范围

这两者是管理员配置的能力组合，不是多写一个 capability 名称就能工作。先读 `examples/implementation.ts`、`examples/pr-analysis.ts` 以及本页的工具与发布配置，按部署约束把增量合入可信配置。

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

## 把 Issue 交给已授权的实现角色

把一个 GitHub Issue 交给已配置的 Sandcastle implementation 能力，它会在隔离分支中尝试实现、运行测试并创建 Draft PR。你得到的是待审查的 Draft PR，不是自动合并的改动。

目前没有网页 UI，也不能把 Issue URL 直接提交；服务不会自动拉取 Issue。每次使用前，管理员必须先部署并交付以下信息：

- 应用目录 `APP` 的绝对路径。
- 数据目录 `DATA` 的绝对路径；控制 socket 位于 `$DATA/control.sock`。
- 已登记目标仓库的 repo ID。
- `implementation` 能力、测试工具和 Draft PR 发布权限已配置并完成部署验收。
- 该仓库本地 checkout 中可访问的固定基线 commit SHA。拿不到这些信息或配置未就绪时，单靠复制本指南无法提交。

### 提交一次 Issue 实现任务

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

## 交给 cron 或 systemd 定时提交

外部定时设施只负责触发提交；服务仍通过本机 CLI/socket 接纳和查询。安装依赖后，用固定 JSON 文件描述要提交的内容，不能在每次触发时重新解析 SHA、分支或动态范围：重送必须保持请求内容不变。

```json
{
  "repo": "example",
  "capability": "test-commit",
  "input": "0123456789012345678901234567890123456789",
  "source": "nightly-test"
}
```

保存为管理员维护的 `/etc/sandcastle/nightly-test.json`，再由 cron、systemd timer 或普通脚本运行：

```sh
node --import tsx examples/external-submission.ts \
  --socket /srv/orchestrator-data/control.sock \
  --file /etc/sandcastle/nightly-test.json \
  --task nightly-test \
  --scheduled-at 2026-10-11T02:00:00.000Z
```

`--task` 是稳定且显式的任务标识，`--scheduled-at` 是这次预定触发时间。脚本根据两者构造去重键，并把计划时间和提交 JSON 一起交给现有 `submit` CLI；同一次触发重送时必须使用相同参数及同一份文件。若 SHA、范围或其他输入发生变化，应当明确创建新触发标识/计划时间，不得让重送时的“最新”值悄悄改变旧请求。`source` 是 `list --source` 可查询的来源范围。

脚本接纳成功时输出 JSON 回执。内容校验拒绝、同键内容冲突、CLI 或 socket 失败都会写入 stderr 并以非零状态退出；调度器应监控退出码，不能把拒绝当成成功。成功的重复提交会返回已有请求和执行，不产生第二条记录。已接纳工作未结束时，新计划触发仍会被接纳；去重键不是重叠锁，也不取消或替换旧工作。

### 处理错过的触发和重叠

定时设施应配置为不逐次补跑停机期间错过的触发。服务和脚本不会推导缺失的计划，也不会自动补跑。需要补跑时，管理员应明确选择任务及时间/输入范围，使用单独、明确的触发时间或标识提交；不要把已接纳工作的重试误认为补跑。

cron 和 systemd timer 的默认行为通常不为每个错过的周期逐次触发。本例显式使用 `Persistent=false`。`Persistent=true` 会在恢复后补触发一次错过的日历事件，并不是逐次回放，但这里也不默认启用；cron 重启后不会遍历错过的每次任务。任何外部包装器都应保持这一语义，避免自行追补整段停机时间。

不要用“先查是否运行、再提交”防止重叠，这存在竞争窗口。确实要求防重叠时，由有该需求的外部设施承担互斥；本脚本不提供锁。

### 准备提交账号和权限

以下外部脚本和通知脚本是源码示例，不随 npm 包提供。先在控制服务主机的独立应用目录部署经过审查的固定版本源码，运行 `pnpm install --frozen-lockfile`，再按示例绝对路径运行；不要从业务仓库执行来路不明的脚本。在控制服务主机上安装固定版本的应用依赖并运行脚本。调度账号只应获得运行 Node、读取固定提交文件及配置、访问控制 socket 所需的最小权限；socket 权限由服务控制。提交文件和输入记录可能包含敏感数据，不要写入凭据，按敏感配置保护文件和日志。不要给脚本授予目标仓库之外的额外权限，也不要以 root 运行，除非部署本身确有必要。

去重只抑制同一来源范围内同键、同内容的重复接纳；同键异内容是冲突。不同计划时间/任务标识会创建独立请求。此机制不保证能力产生的外部副作用幂等；能力本身仍需按业务需要处理重复执行。

该提交入口不改变旧请求记录。没有去重键的旧 CLI 调用仍按原规则每次创建新请求；既有记录仍可查询，计划时间和去重键仅适用于通过新参数提交的请求。

### 配置 cron

下例每晚 02:00 UTC 提交一次。计划时间取本次触发的 UTC 日期和固定 02:00 时点；明确重送时使用当时保存的时间，不重新运行 `date`。

```cron
CRON_TZ=UTC
0 2 * * * cd /opt/sandcastle-orchestrator && node --import tsx examples/external-submission.ts --socket /srv/orchestrator-data/control.sock --file /etc/sandcastle/nightly-test.json --task nightly-test --scheduled-at "$(date -u +\%Y-\%m-\%d)T02:00:00Z"
```

确认所用 cron 支持 `CRON_TZ`；否则将主机/cron 时区设为 UTC。cron 中的 `%` 需要转义。该例不启用自动重送，失败后由管理员携原计划时间及原 JSON 文件明确重送。

### 配置 systemd timer

服务单元 `/etc/systemd/system/orchestrator-nightly.service`：

```ini
[Service]
Type=oneshot
User=orchestrator
WorkingDirectory=/opt/sandcastle-orchestrator
ExecStart=/bin/sh -c 'exec /usr/bin/node --import tsx examples/external-submission.ts --socket /srv/orchestrator-data/control.sock --file /etc/sandcastle/nightly-test.json --task nightly-test --scheduled-at "$(date -u +%%Y-%%m-%%d)T02:00:00Z"'
```

定时单元 `/etc/systemd/system/orchestrator-nightly.timer`：

```ini
[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=false
AccuracySec=1s
Unit=orchestrator-nightly.service

[Install]
WantedBy=timers.target
```

管理员检查路径和账号后执行 `systemctl daemon-reload`、`systemctl enable --now orchestrator-nightly.timer`。systemd 单元内 `%` 要写成 `%%`。此例固定日历时点，不配置自动重启/重送，错过整天不补跑；跨日异常延迟时应人工核对计划日期。需要可靠重送的外部设施应保存触发时间和输入快照，不重新计算。

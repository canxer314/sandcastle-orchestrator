# 新增只读角色与组合任务

本教程从包外可信配置开始，新增 `repository-question` role，在获准的小型 Git 仓库的固定 commit 上回答问题，再查询本地报告。完整文件是 [config.ts](../examples/readonly-role/config.ts)，可选组合在 [composition.ts](../examples/readonly-role/composition.ts)。它们只 import 正式包和已安装依赖，不依赖内部源码。

这里使用已交付的 `serve`、`submit --input`、`show`、`logs` 和 `artifact`。不需要 setup 生成器，不引入 workflow DSL、条件分支或自动多角色串联。原有 [Issue 到 Draft PR](user-guide.md)、[部署与运维](deployment-guide.md) 和 README 中的 implementation、Draft PR、PR analysis 仍是需要单独配置、权限和验收的高级用法。本教程不授予修改或发布权限，也不扩大历史真实验收的适用范围。

## 1. 准备独立资源和执行条件

需要 Linux、Node.js 24+、npm、Git、util-linux `flock`，以及已安装的正式 CLI。当前尚未发布 npm/Release，先按[安装说明](installation.md)安装维护者交付的本地 tgz。安装消费者不需要源码或 pnpm。下面以同一份已验收 tgz 为配置依赖，不能用全局 CLI 的 node_modules 代替配置自己的依赖。

真实运行还要求管理员准备并授权以下资源。缺一项就先停在类型检查，不要把配置加载成功当成模型连接成功。

- 本机 Docker daemon，且当前用户已有使用权限。不会自动安装、提权或拉镜像。
- 已预部署的可信镜像，含 POSIX `sh`、`env`、Git、Node.js 和可用的原版 Claude Code CLI。记下镜像 digest 与容器 CLI 版本。不要把仅有 Node 的测试镜像当作 Agent 镜像。本教程没有验证某个真实镜像，也不提供未验收的镜像名。
- 用户明确授权读取的独立 settings JSON，或明确选择复用的 live settings JSON，路径为绝对路径。它必须提供当前连接投影支持的静态 client-facing API key 或 Bearer token，且恰好一个有效。不要把值写进教程文件、任务输入或报告。复用不意味着复制整个 home、hooks、插件、MCP、permissions、CC-Switch 数据库或订阅登录。
- 容器可达的 Anthropic Messages-compatible endpoint 与该 endpoint 接受的模型名。这是 Claude Code harness 的连接，不限定物理模型或上游认证来自 Anthropic。普通 Docker `bridge` 可出网；它不是 endpoint-only 隔离。宿主 `localhost` 通常无法从容器访问，本教程不建立自动桥，也不要求修改私人代理 listener。不支持的 helper、OAuth、云凭据、代理或 TLS 依赖需要管理员另行处理，不能自动换身份或关闭 TLS 校验。

连接白名单、优先级、秘密过滤的限制见[连接投影](connection-projection.md)。本例使用公开依赖 `@ai-hero/sandcastle@0.12.0` 的 `claudeCode(model)`，显式要求模型名。省略模型的内部适配器不在当前包根公开导出中，本教程不从 `src/connection` 偷导入、不自己复制适配器。显式值会覆盖连接来源的模型；代理最终路由仍由代理决定。

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

保存实际回执的 `requestId` 和 `executionId`。`accepted:true` 只代表受理，提交是异步的；默认 JSON 下即使 `accepted:false` 也可能 exit 0，不能只看进程退出码。source 是追踪字段，不是认证身份。回执丢失时先查当前实例 `list` 和已知记录，不自动重发；这里不依赖尚未交付的新输入或受理核对选项。

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

停止服务前先核对所有执行及工具。服务终端的 Ctrl+C 不是任务停止保证；不要直接据此清理 data、容器或凭据。保留证据，按 README 的维护流程操作。

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

已有 implementation + test tool + Draft PR 发布流程和 PR snapshot analysis 仍按各自指南与授权运行。不要将它们合进最小只读 role。原 PR analysis 的 endpoint-only 约束和历史受控/真实证据属于那个部署场景，不作为本例普通 bridge 的隔离保证，也不据本教程改写历史验收。

## 验证记录与命令依据

2026-10-16，基线 `e984d26`，Linux x86_64、Node.js v24.21.0、npm 12.0.2、pnpm 12.3.4、包版本 0.1.0。示例没有变更生产接口、记录或管理协议，未为纯文档/示例新增行为 changeset。

| 命令或约定 | 当前依据 |
| --- | --- |
| tgz 安装、外部 ESM 依赖、`tsc` | [安装说明](installation.md)，`tests/package.test.ts` 的独立 prefix 和配置项目消费 |
| `serve --config --data`、显式 socket | `src/help.ts`、现有 CLI/socket 入口与 `tests/management.test.ts` |
| `submit --repo --capability --input --source` | `src/cli/management.ts`、`tests/roles.test.ts`，role 使用现有 capability 字段 |
| `show/list/logs/artifact`、attempt/call/offset | `src/cli/queries.ts`、`src/control.ts`，不新增 result/wait 命令 |
| 只读 role、报告校验、确定性工具绑定 | `src/roles.ts`、`src/mcp.ts`、公开 `Configuration/Role` 与 `configureClaudeMcp` |
| Git SHA、资源创建和 JSON 编码/解码 | Git、POSIX shell、Node/npm 自身命令，不是新 CLI 能力 |

维护者可复跑以下检查，不要求安装消费者使用 pnpm。

```sh
pnpm run typecheck
pnpm exec vitest run tests/package.test.ts tests/roles.test.ts tests/management.test.ts tests/mcp.test.ts
pnpm test
```

`tests/package.test.ts` 直接复制本教程两个文件到源码之外的 ESM 项目，安装同一 tgz 及显式依赖，使用该项目自己的 TypeScript 检查。正式已安装 CLI 经真实 socket 完成非法输入拒绝、固定 SHA role 受理/查询、报告 artifact 和日志读取；另加载组合配置并独立提交 `list-root`。仅 provider 与 Docker binary 替换成受控 adapter，不快照私有实现。断言只读启动参数和原 checkout 不变，不冒充内核写保护证据。

本次 `pnpm run typecheck` 通过；`pnpm test --maxWorkers=1` 全套 14 文件、274 项通过、20 项真实环境 opt-in 跳过，其中包消费 8 项、role 26 项、management 86 项、MCP 12 项。教程的 10 个 shell 代码块通过 `sh -n` 语法检查，没有据此执行 Docker 或模型。首次并发定向和全套曾出现既有 ready/restore/MCP 等待超时，串行全套原断言通过，未修改生产代码或放宽超时。

未运行真实 Docker、真实模型、私人连接、远端调用或发布，未验收所选镜像、认证、网络可达、模型答案和 role 实际调用 `list_root`。这些须在另获授权的环境通过相同用户入口验收并记录镜像/CLI 版本、固定 SHA、答案核对和独立停止证据。受控 adapter 通过不补齐父规格 #65 的真实 Agent 接入，也不替代历史特定环境的验收。

# 从 Git 项目到只读模块报告

本教程面向会用终端、但不熟悉项目内部设计的用户。目标是在你已有的 Git 项目上，提交“说明主要模块及调用关系”的只读分析，查看进度，找到并核对报告。不写 TypeScript，不配置内部角色或调度器。服务使用本机 CLI，没有网页 UI，也不会根据任意 Issue URL 自动交付或合并 PR。

先按[安装指南](installation.md)安装正式 CLI。demo 是可选的环境练习，不是分析真实项目的前置步骤；它成功也不证明模型连接可用。本教程使用 Linux、Node.js 24+、npm、Git、util-linux `flock` 和本机 Docker daemon，不需要 pnpm。

## 1. 选定已有项目与授权范围

选择自己有权交给模型服务阅读的本地 Git checkout，至少已有一个 commit。以下路径要换成你的项目绝对路径，不是编排器安装目录。

```sh
PROJECT='/absolute/path/to/your-project'
git -C "$PROJECT" rev-parse --show-toplevel
git -C "$PROJECT" rev-parse --verify 'HEAD^{commit}'
git -C "$PROJECT" status --short
```

这里读取现有仓库，不 clone、fetch、commit、reset 或切分支。后续 setup 固定当时 HEAD 的完整 SHA，未提交修改不会进入报告。需要分析新修改时先自行审查和 commit，再准备新的输入，不要误以为分析的是工作区。

先检查已提交内容是否含密钥、客户数据或其他不能发送给模型服务的材料。只读挂载不等于数据不出机器，Agent 会把阅读的代码和问题发往选定 endpoint。当前固定树导出不支持 symlink/submodule，也不能提交 `.sandcastle/.env`；不满足时先停止，不能把失败当成已分析。

## 2. 准备模型连接

你可以复用本机已经使用的 Claude Code 连接，无需为了编排器重新买一个账号。可复用的是明确选定的 `settings.json` 中受支持的静态连接，不是宿主整个 Claude Code 环境。`/login` 的 OAuth/订阅登录、helper、云凭据和 CC-Switch 数据库不能自动搬进容器。

本机 settings 已满足下面的连接条件、并且你授权复用时，在下一步改用 `--reuse-local-claude` 即可。它指向 `$CLAUDE_CONFIG_DIR/settings.json`，未设置时指向 `~/.claude/settings.json`。不要把文件内容贴进终端记录或公开问题中。setup 不读取或探测认证；宿主 Claude 能运行也不能证明容器能用。

**下面主路线使用独立连接文件**，不会修改你正在使用的 Claude Code 或 CC-Switch 配置。没有现成连接时按下面准备；已有连接但不在支持范围时，请连接管理员提供容器可用的独立连接，不要自动换身份或关闭 TLS。

### 获取连接信息

向你选择的模型服务或组织管理员确认以下信息：

- Anthropic Messages-compatible endpoint 地址。直接使用 Anthropic API 时可用 `https://api.anthropic.com`；其他服务必须明确支持 Claude Code 使用的 Messages 协议，只有 OpenAI-compatible 地址不够。
- 一个该 endpoint 接受的静态 API key 或 Bearer token，恰好一个。本教程示例用 API key。
- 该 endpoint 接受的模型名称。不能从代理的显示名猜测实际模型；让服务方提供准确名称。
- 账号已获授权、可用额度、数据处理政策与计费方式。

没有账号时，先到所选服务的官方控制台注册或由组织管理员开通 API 访问，在其密钥管理页面创建限权密钥，并按服务方要求开通计费。本程序不代开户、充值、创建 key 或查询余额。Claude 订阅不等于可用于此投影的 API 凭据。不要在聊天、任务输入、配置代码或仓库中粘贴密钥。

实际执行可能产生模型和代理费用；这里没有模型消费预算或费用查询命令。先在服务方设置自己可接受的限额与提醒，用获准的小项目提第一个问题。重试也可能再次计费，取消回执不保证远端已停止或不再收费。

### 保存独立文件

在项目和安装目录之外新建受保护目录。下面仅在目录成功新建后打开编辑器。目录已存在或创建失败时不编辑文件；先检查并选新目录，不删除已有秘密文件来重跑。

```sh
umask 077
CONNECTION_DIR="$HOME/.config/sandcastle-model-connection"
mkdir -p "$(dirname "$CONNECTION_DIR")"
if mkdir -m 700 "$CONNECTION_DIR"; then
  CONNECTION="$CONNECTION_DIR/settings.json"
  ${EDITOR:-vi} "$CONNECTION"
  chmod 600 "$CONNECTION"
else
  unset CONNECTION
  printf '%s\n' '目录已存在或创建失败；先检查并选择新目录，不编辑已有凭据。' >&2
fi
```

在编辑器中写入下面 JSON，替换所有占位值。通过编辑器填写避免密钥进入 shell history；不要用带密钥的命令参数或共享剪贴板记录。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_API_KEY": "REPLACE_IN_PRIVATE_EDITOR",
    "ANTHROPIC_MODEL": "REPLACE_WITH_PROVIDER_MODEL_NAME"
  }
}
```

若服务方要求 Bearer token，把 `ANTHROPIC_API_KEY` 这一整项替换为 `ANTHROPIC_AUTH_TOKEN`，不要同时保留。endpoint 可含路径，但不能内嵌账号密码、query 或 fragment。除可核实的本机 HTTP loopback 桥外，必须是容器可达的地址；HTTPS loopback、远程/rootless Docker 和 Docker Desktop 不在自动桥支持范围。不要开放私人代理到全网，也不要禁用证书校验。

这条路线不支持自动迁移 `/login`、OAuth、`apiKeyHelper`、profile/WIF、Bedrock/Vertex/Foundry、宿主 HTTP proxy、自定义 CA/mTLS 等依赖。容器镜像须没有企业 managed settings；程序不会绕过企业策略。完整白名单和网络条件见[连接参考](user-guide.md#维护模型连接)。

独立文件仅由你管理；每次尝试开始前读取一次。同路径文件的修改影响下一次尝试，不改变已开始的执行。服务配置记录来源路径而非认证值。容器进程、可信配置、镜像及有权限的 Docker/宿主管理者仍可能看到运行时凭据，保留容器也可能保留认证环境；日志过滤不是通用防泄漏系统。

## 3. 生成项目入口

沿用第一步的 `PROJECT` 和第二步的 `CONNECTION`。选择新资源名 `module-analysis`，方便后续命令一致；如果已用过该名字，先查旧实例和证据，再换名字，并使用新输出中的实际路径和标识。

```sh
sandcastle-orchestrator setup --project "$PROJECT" \
  --name module-analysis --connection-settings "$CONNECTION" \
  --question '说明这个项目的主要模块及调用关系，给出可核对的文件引用，区分事实、推断和缺失证据。'
```

核对显示的项目根目录、固定 SHA、问题、连接来源、镜像和资源路径，再输入 `yes`。默认创建：

| 内容 | 本例路径 |
| --- | --- |
| 可信服务配置 | `~/.sandcastle-orchestrator/projects/module-analysis/config/config.mts` |
| Agent 镜像配方 | 同配置目录的 `Dockerfile` |
| 记录、日志与报告 | `~/.sandcastle-orchestrator/projects/module-analysis/data/` |
| 提交输入 | `~/.sandcastle-orchestrator/projects/module-analysis/input.json` |

配置与输入没有认证值。setup 只生成资源，不启动服务、不提交、不构建镜像、不调用模型，也不证明 endpoint 可达。它不会覆盖已有资源或接管旧实例。安全冲突与替代来源见 [setup 参考](user-guide.md#调整-setup-生成的入口)。

## 4. 准备 Agent 镜像

demo 的 Node 镜像不能运行 Agent。setup 生成的是含原版 Claude Code `2.1.296` 的 Dockerfile，不是已可拉取的项目官方镜像。先审阅配方，然后明确授权本机 Docker 构建。构建会联网下载基础镜像、系统包和 CLI，可能有网络/存储费用，但以下版本检查不调用模型。

```sh
BASE="$HOME/.sandcastle-orchestrator/projects/module-analysis"
docker build --tag sandcastle-orchestrator-claude:2.1.296 - < "$BASE/config/Dockerfile"
docker image inspect sandcastle-orchestrator-claude:2.1.296
docker run --rm --pull=never --network none --entrypoint claude \
  sandcastle-orchestrator-claude:2.1.296 --version
```

以输出确认为准。基础标签和 apt 包不是 digest 锁定，需严格复现时记录实际镜像 ID。构建失败时先修复可信下载途径，不能为下载开放私人代理或关闭 TLS。只有 `node` 的镜像、宿主已安装的 Claude Code 都不能替代此镜像。自定义镜像见 [setup 参考](user-guide.md#调整-setup-生成的入口)。

## 5. 终端 A：显式启动服务

核对生成配置是刚才信任的文件，加载它会执行宿主代码，配置校验不是沙箱。使用 setup 输出的完整 serve 命令；本例为：

```sh
BASE="$HOME/.sandcastle-orchestrator/projects/module-analysis"
sandcastle-orchestrator serve --config "$BASE/config/config.mts" --data "$BASE/data"
```

保持这个终端运行。stdout 出现 `ready:true` 只表示控制服务就绪，不表示模型连接成功。不要在同一 data 上再启动一个实例。

## 6. 终端 B：提交模块分析

新终端先恢复 CLI 的 PATH，然后使用 setup 输出的 submit 命令。本例的 repo 和任务名由 `--name module-analysis` 生成，不是让你学习内部模型：

```sh
export PATH="$HOME/.local/sandcastle-orchestrator/bin:$PATH"
BASE="$HOME/.sandcastle-orchestrator/projects/module-analysis"
sandcastle-orchestrator submit --data "$BASE/data" \
  --repo module-analysis --capability module-analysis-question \
  --source setup-module-analysis --input-file "$BASE/input.json" --human
```

这是开始真实模型执行的步骤，会读取授权连接并可能计费。只提交一次。保存输出的 `requestId`、`executionId` 以及 stderr 中的 source、deduplication key 和核对命令。接纳只代表进入队列，不表示完成。

如果拒绝，读原因再处理；如果超时或丢回执，使用已打印的核对命令，不重新提交。没有查到记录也不能证明安全重发。文件输入、去重与退出码见[提交参考](queries.md#提交任务并保留回执)。

## 7. 查询进度，找到报告

把下面编号替换为本次回执的真实 executionId，不要原样复制占位值。

```sh
DATA="$HOME/.sandcastle-orchestrator/projects/module-analysis/data"
EXECUTION_ID='REPLACE_WITH_ACTUAL_EXECUTION_ID'
sandcastle-orchestrator show "$EXECUTION_ID" --data "$DATA" --human
sandcastle-orchestrator logs "$EXECUTION_ID" --data "$DATA" --human
```

查询可以重复，不会新建任务，也不会自动等待到完成。看 `show` 中的状态与实际 attempt：

| 状态 | 下一步 |
| --- | --- |
| `queued` | 已接纳，稍后用同一编号再次查询 |
| `starting` / `running` | 正在准备或运行，等待，不重复提交 |
| `completed` | 入口有结束记录，继续核对报告、contract、实际 SHA 和停止证据 |
| `unknown` | 结果或停止证据不确定，保留现场并查证，不盲目重试 |

`show --human` 直接显示可读业务报告或结果引用。检查 `Actual SHA` 与 setup 显示的 SHA 一致，报告是否回答模块与调用关系、是否有可核对的文件引用、是否说明不确定性。`contract: valid` 在这里仅代表报告非空；不是答案正确、测试通过或安全停止的证明。模型声称测试通过也不构成本任务的测试证据。

完整原文保存在实际 attempt 目录的 `artifacts/report.txt`，路径以查询结果中的实际 location 为准，不要猜 attempt 编号。在线也可查询产物：

```sh
sandcastle-orchestrator artifact "$EXECUTION_ID" --data "$DATA" --name report.txt --human
```

artifact 输出保留 base64 和分段信息，不自动转成纯文本。通常直接阅读 `show --human` 就够了；解码、日志截断、多次 attempt 与大报告读取见[查询参考](queries.md)。报告只是分析材料，按固定版本人工核对后再决定后续操作。

## 完成后与遇到问题时

服务不会因提交结束自动退出。停止服务前先用 `list --data "$DATA" --human` 和 `show` 核对执行、工具及停止证据；没有活动或未决执行后，再在终端 A 按 Ctrl+C 结束服务。Ctrl+C、socket 消失或控制服务退出本身不证明 Agent 已停止。未知执行交给[管理员恢复流程](queries.md#取消执行并人工恢复)，不要删数据库、锁或强制删除容器来制造结束。

- 找不到 socket：确认终端 A 的实例及 data 路径，客户端不会代启动服务。服务已退出时先用[离线查询](queries.md#离线读取现有证据)，不要仅为看报告而启动可能调度旧任务的服务。
- `start_failed`：先看 show/logs，核对本地镜像、连接支持范围、恰好一个有效认证和容器可达 endpoint。不要贴出 settings 或认证环境，也不要自动换账号。
- 没报告、空报告、`contract: error`：保留 attempt 原始报告与日志，不能把 `completed` 当成功。
- 新问题或新 commit：另行准备输入并显式提交，见[提交参考](queries.md#提交任务并保留回执)。retry 会新建 attempt，不会让原输入自动更新到新 HEAD。

安装、配置、data 和连接文件相互独立，卸载程序不会删除报告或秘密文件。换版、备份和清理见[部署维护](deployment-guide.md)。需要新增业务行为时再读[自定义角色与能力](readonly-role-tutorial.md)，修改代码或发布 Draft PR 需要另行配置和授权。

## 调整 setup 生成的入口

按需要选择以下参数。setup 只生成新资源，不读取连接、不执行模型，也不修复已有部署。

### 参数速查

| 参数 | 用途 |
| --- | --- |
| `--name NAME` | 新资源名，1–64 位小写字母、数字、连字符或下划线，首位为字母或数字 |
| `--question TEXT` | 固定版本上的非空问题 |
| `--model NAME` | 显式客户端模型名，默认继承 |
| `--image IMAGE` | 已有可信 Agent 镜像 |
| `--config FILE` / `--data DIR` / `--input-path FILE` | 指定互相独立的新资源路径 |
| `--non-interactive` | 即使在终端中也禁止询问 |
| `--yes` | 确认创建，不跳过授权或冲突保护 |
| `--json` | stdout 仅输出结果，诊断在 stderr |

自定义 `--image` 保留镜像配置，但生成配方和 prepareImage 命令仍只构建推荐标签。自定义镜像须自行准备 POSIX sh、env、Git、Node.js 和兼容的原版 Claude Code；只有 Node 的 demo 镜像不适用。

### 选择连接来源

先考虑复用本机已授权的静态连接。`--reuse-local-claude` 只引用 settings，不迁移 `/login` OAuth/订阅登录、helper 或 CC-Switch 数据库。宿主能运行不代表容器可用。没有受支持的现成连接时，按[主教程](user-guide.md#2-准备模型连接)准备独立 settings，确认 endpoint、认证、模型名、数据授权和费用。

非交互必须明确选择来源并加 `--yes`，缺项立即退出。JSON stdout 只有结果；摘要、警告与确认在 stderr。`--non-interactive` 在终端中也禁止询问。

```sh
# 明确授权选用本机当前 settings 来源，不复制 secrets
sandcastle-orchestrator setup --project /srv/my-project --reuse-local-claude --yes --json

# 独立连接文件，setup 不读取它，每次执行前由现有投影加载
sandcastle-orchestrator setup --project /srv/my-project \
  --connection-settings /srv/private/container-settings.json --yes --json

# 从之后由用户主动启动的 serve 进程环境投影连接，不是捕获 setup 的环境
sandcastle-orchestrator setup --project /srv/my-project --connection-environment --yes
```

`--reuse-local-claude` 记录 `$CLAUDE_CONFIG_DIR/settings.json`，未设置时为 `~/.claude/settings.json`。`--yes` 仅确认新建文件，不能替代来源选择。setup 本身不读取任何连接内容，输出模型为 `inherit` 或显式 `--model` 的后端名称，不冒充已解析实际模型。

连接白名单、认证冲突、unsupported helpers 和模型继承全部复用 [连接投影](user-guide.md#维护模型连接)。不新增认证方式，不强制另取 API key 或登录；宿主 `/login` 凭据复制/共享挂载不是受支持的迁移方式。生成资源只保存来源路径和非敏感选项。容器及获授权 Docker 管理者可能看到运行时认证，不能据此宣称完全隔离凭据。

执行级 HTTP loopback 桥仅支持可核实的本机 Linux rootful Docker bridge；HTTPS loopback、远程/rootless Docker 等须使用容器可达 endpoint，限制见 [连接投影与执行桥](user-guide.md#维护模型连接)。setup 不探测桥、endpoint 或认证；生成成功不代表连接可用。

### 检查资源冲突与手工合并

默认布局为 `~/.sandcastle-orchestrator/projects/PROJECT/`，包含 `config/config.mts`、同目录 `Dockerfile`、独立 `data/` 和 `input.json`。repo ID 来自项目名，role 为 `PROJECT-question`。`.mts` 配置明确使用 ESM，不创建或改写现有 package.json。

名称或文件冲突时换 `--name`，或显式指定全新的 `--config`、`--data`、`--input-path`。已有文件、符号链接、data 目录均不覆盖，reference-only 允许选现有 data 但不写入，`--yes` 不绕过物理路径和包含关系保护。资源不得位于安装目录、目标项目、Git metadata 或默认 demo 目录内，也不能反过来包含它们。物理路径祖先存在 `.git` 或 `init.json` 时也拒绝，保护自定义 demo 仓库/data；不加载其中的配置或标记。不自动删除失败留下的文件。

已有自定义部署可用 `--reference-only --config /srv/new-reference/config.mts --data /actual/existing-data`，只生成新参考配置、输入和镜像配方供手工合并，不读取或重写已有配置，也不创建或修改 data。此时必须先把 repo/role/provider/environment/binding 合并进自己的可信配置，再调整输出中的 serve 配置路径；submit 仍须显式指定目标和 source。

生成配置通过当前安装的公开 `index.js` 的绝对 file URL 导入 `claudeCode`，不依赖全局包解析或内部深层导出。移动安装位置后须手动更新 import；常规同 prefix 换版本保留路径。可信配置加载会执行代码，不能把 serve/doctor 的配置检查说成纯静态无副作用。配置、data、输入和历史不随程序卸载删除。

## 维护模型连接

下面面向需要手工维护 provider 的配置管理员。首次使用可保留 setup 生成的引用。

### 选择来源

```ts
import { claudeCode } from '@canxer314/sandcastle-orchestrator';

// 放入既有 Configuration.providers，保留角色、绑定、repo 和环境定义。
const providers = [{
  id: 'claude',
  agent: claudeCode(),
  connection: {source: 'settings', path: '/absolute/authorized/settings.json'},
}];
```

`connection` 是明确的读取授权，只保存来源描述，不保存认证值。settings 路径必须是绝对路径，指向用户明确选定的 live Claude Code settings JSON 或单独准备的容器可用 JSON。只提取 `env` 和顶层 `model`，不导入 hooks、插件、MCP、permissions、home 或凭据库；不会寻找其他文件、合并项目 settings 或读取 CC-Switch 数据库。无需也不得把认证值复制进 TypeScript 配置或提交输入。

也可明确选择 `{source: 'environment'}`。这只读取控制服务进程的当前环境白名单，不读取 shell profile，不执行 helper。父 shell 在服务启动后的环境变化不会改变已运行进程；需要 live 文件切换时选择 settings 来源。

每次尝试开始后、创建容器前读取一次。相同路径下的直连配置切换影响下一次尝试和人工 retry，不重新导入已开始尝试。部署配置本身仍只在 serve 启动时加载。读取失败、认证缺失或不支持依赖都使本次尝试 `start_failed`，不会改用旧 docker.env、宿主身份、订阅登录或另一 provider。

### 检查优先级与模型

1. 选择 settings 时完全忽略宿主连接环境；选择 environment 时只读该进程白名单。
2. 清除旧 `docker.env` 中的连接、云认证、代理及 Claude 行为字段，再投影所选来源。其他显式容器环境保留。长生命周期 sandbox 不自动注入 `agent.env`。
3. 容器 exec 使用 `env -i`，只保留本次明确环境及 HOME/Git/PATH 设施变量，不继承镜像中旧身份或模型环境。选定来源时追加原生 `--setting-sources ''`，避免镜像、user/project/local settings 再次覆盖。镜像需提供 POSIX sh、env、Git 和 Claude Code；不提供环境清洗回退路径。`--setting-sources` 不控制 managed settings，故容器预检及命令启动检查发现 `/etc/claude-code/managed-settings.json` 或 `managed-settings.d` 时明确失败，不解析、合并或绕过企业策略。请选择独立配置、没有这些 managed settings 的可信镜像；已创建但未启动 harness 的容器保留审计，缺少停止证据仍是 unknown。
4. 来源 `ANTHROPIC_MODEL` 优先于顶层 `model`，后者转换为本次环境中的 `ANTHROPIC_MODEL`。没有两者时由 harness/client endpoint 选择默认模型，不注入项目 Claude 默认值。
5. `claudeCode()` 真正省略 print/interactive 的 `--model`；这是对锁定 Sandcastle 0.12.0 原生 builder 的薄适配，依赖升级须复核命令形状。`claudeCode('backend-model', options)` 保持 Sandcastle 0.12.0 的显式参数、stdin、parser、session 与 options 契约。原始 Sandcastle factory 仍可使用，原显式调用不变。显式模型参数优先于来源模型，字符串原样传递，不维护后端映射表。

CC-Switch 代理只作为 client-facing endpoint。协议转换、动态路由、failover 和实际物理模型归代理，不从本次 client 配置推定实际请求路由。兼容开关和新模型 alias 是否生效取决于镜像里的 Claude Code 版本，不承诺宿主与容器 CLI 相同。

### 核对支持字段

仅支持 Claude Code 的 Anthropic Messages-compatible endpoint，不限定 Anthropic 模型或上游认证方式。认证是 endpoint 的静态 client-facing API key 或 Bearer token，二者恰好一个非空，这是本投影的冲突限制，不是 harness 官方所有调用的限制。省略 BASE_URL 时使用 harness 原生默认 endpoint；提供时必须为 HTTP(S)，保留路径，拒绝 URL 内嵌认证、query 和 fragment。

明确 env 白名单：

- `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`。
- `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、旧兼容字段 `ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`。
- `ANTHROPIC_BETAS`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、`CLAUDE_CODE_DISABLE_THINKING`、`DISABLE_INTERLEAVED_THINKING`、`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`、`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`、`ENABLE_TOOL_SEARCH`。

不按前缀放行未知 `ANTHROPIC_*`。字段仅接受无 NUL 的字符串。custom headers 使用逐行 `Name: Value`，拒绝重复名称、控制字符、折行、认证头和 Host/Content-Length/Transfer-Encoding/Connection/anthropic-version/anthropic-beta 冲突。beta header 通过专用字段设置，显式 beta 与禁用实验 beta 同时有效时拒绝。

不支持的有效依赖明确失败，包括 `apiKeyHelper`、云凭据/helper、OAuth/订阅 token、profile/WIF、Bedrock/Vertex/Foundry 等云选择器、host-managed routing、任意 extra body、强制 subagent model、宿主 HTTP(S)/ALL proxy、CA/mTLS 文件与关闭 TLS 校验。不会执行或搬运 helper、认证文件、云凭据，也不会自动单独登录或生成 token。若 live 配置依赖这些项，用户可以另行明确选择独立的容器可用静态连接；程序不自动替他们选择。

### 保护运行时秘密

认证只在运行时注入。Docker argv 使用 `--env NAME`，值经 Docker CLI 子进程环境传递，不写命令参数、配置快照、Prompt 或任务输入。启动/解析错误不带源内容、路径中的敏感值或 Docker 完整命令。日志、模型输出、业务报告、错误、只读工具 observation 和 session 导出在写盘前过滤本次已知 token/key/header 值，含跨 stream chunk 的匹配及 JSON/URL 转义。可执行 capability/publication 工具在入口拒绝含本次已知连接秘密的输入，避免传播到测试产物或外部写入。未匹配的 binary session 原字节保留。

这是防止已知连接秘密意外回显，不是通用 DLP：无法识别模型主动改写、拆分编码的任意秘密，也不清洗用户原有文件、业务仓库或外部 MCP 服务自行保存的内容。不要把认证放进任务输入、角色说明、工具参数或自定义 provider 命令。可信配置代码和镜像仍有权限看到运行时认证；容器进程和获授权 Docker 管理者也可看到，Docker CLI 子进程环境亦可能被有权限的宿主进程检查；Docker 保留容器的 Config.Env 可能持续保留值，管理员核查后负责清理。不承诺完全凭据隔离。

保持只读 repo、权限、目录分离、不挂宿主 home/Docker socket、host 网络禁令和 unknown 审计。允许角色显式使用普通 Docker bridge 出网，不要求新增网络治理设施；确定性测试路径继续禁网。

### 执行级 localhost 桥

无需新命令或配置字段。沿用上面的授权来源和现有 role 执行入口，将对应 `docker.network` 明确配置为 `bridge` 或已有本机 bridge network。省略网络仍是 `none`，不会自动切换。没有显式 `connection` 的旧 provider 不变；所选 endpoint 不属于 loopback 时原样使用，不做 Docker 桥探测或创建 relay。省略 endpoint 仍沿用 harness 默认值。

自动桥只支持 HTTP 的 `localhost`、`localhost.`、`127/8`、`::1` 及 IPv4-mapped loopback。localhost 解析结果必须全部是 loopback，本次固定这些地址，不在转发中重新解析。执行设施使用与容器相同的 Docker CLI 环境，核验 Linux、root-owned 本机 Unix socket、非 rootless/非 Desktop daemon、local bridge network，以及 gateway 在对应本机 bridge 网卡上。网络创建后使用完整 network ID；监听实际 gateway 的随机临时端口，核对实际绑定结果，绝不监听 `0.0.0.0`。不创建网络、不改防火墙、不提权、不切 host 网络、不注入 Docker socket，也不要求修改代理 listener。

relay 在容器创建前 ready，默认不放行任何来源。容器创建后以返回的完整 ID 核验 running 状态、单一 bridge 附着、实际 IP 和 gateway，完成后才启动 harness。每个新连接还需复核原 ID 和 network 的 IP 归属，其他来源直接关闭；最多 8 个并行身份核验、64 个客户端连接，Docker 探测每条命令限 5 秒。它限制普通容器访问和 IP 回收，不是抵抗 Docker 管理者或特权网络伪造的认证。

仅覆盖本次容器 `ANTHROPIC_BASE_URL` 的 host/port，保留 HTTP 协议和 URL 路径，认证、headers、模型和上游路由仍来自所选连接投影。Node TCP 双向 `pipe` 保留背压和半关闭，不解析或记录请求、认证及响应正文。客户端由新 URL 生成的 HTTP Host 会变为 gateway/临时端口；要求原 Host、依赖绝对 loopback redirect 的代理不在透明兼容范围内，不用解析 HTTP 来补写。HTTPS loopback 明确报 TLS/SNI 不支持，必须另选容器可达且证书有效的 endpoint；不会降级为 HTTP、关闭证书验证或自动搬运 CA/mTLS。

启动失败关闭本次 relay 和所有已接入 socket，不借此声称保留容器已停止。协作 cancel 不断桥，最终报告可继续传输；收到现有 Agent exit marker 后立即关闭桥，不等 SDK session 后处理。没有退出证据时保留桥与 unknown，不删除容器证据，不把 Docker client 结束当成 Agent 停止。桥属于当前控制进程，不是持久化代理；控制服务退出会使连接中断，重启不恢复旧桥，也不证明旧 Agent 停止。维护时先确认执行退出或完成既有人工核对，不能停服务来制造安全停止。

远程 Docker、rootless、Docker Desktop、非 bridge、IPv4 gateway 无法核验或本机 bridge 不匹配均明确失败。可以由用户明确选择已经容器可达的 endpoint，程序不会自动尝试另一身份或网络模式。

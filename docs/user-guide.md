# 从 Git 项目到只读模块报告

本教程面向会用终端、但不熟悉项目内部设计的用户。目标是在你已有的 Git 项目上，提交“说明主要模块及调用关系”的只读分析，查看进度，找到并核对报告。不写 TypeScript，不配置内部角色或调度器。

先按 [README](../README.md#安装并运行-demo)安装正式 CLI。demo 是可选的环境练习，不是分析真实项目的前置步骤；它成功也不证明模型连接可用。本教程使用 Linux、Node.js 24+、npm、Git、util-linux `flock` 和本机 Docker daemon，不需要 pnpm。

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

这条路线不支持自动迁移 `/login`、OAuth、`apiKeyHelper`、profile/WIF、Bedrock/Vertex/Foundry、宿主 HTTP proxy、自定义 CA/mTLS 等依赖。容器镜像须没有企业 managed settings；程序不会绕过企业策略。完整白名单和网络条件见[连接参考](connection-projection.md)。

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

配置与输入没有认证值。setup 只生成资源，不启动服务、不提交、不构建镜像、不调用模型，也不证明 endpoint 可达。它不会覆盖已有资源或接管旧实例。安全冲突与替代来源见 [setup 参考](setup.md)。

## 4. 准备 Agent 镜像

demo 的 Node 镜像不能运行 Agent。setup 生成的是含原版 Claude Code `2.1.296` 的 Dockerfile，不是已可拉取的项目官方镜像。先审阅配方，然后明确授权本机 Docker 构建。构建会联网下载基础镜像、系统包和 CLI，可能有网络/存储费用，但以下版本检查不调用模型。

```sh
BASE="$HOME/.sandcastle-orchestrator/projects/module-analysis"
docker build --tag sandcastle-orchestrator-claude:2.1.296 - < "$BASE/config/Dockerfile"
docker image inspect sandcastle-orchestrator-claude:2.1.296
docker run --rm --pull=never --network none --entrypoint claude \
  sandcastle-orchestrator-claude:2.1.296 --version
```

以输出确认为准。基础标签和 apt 包不是 digest 锁定，需严格复现时记录实际镜像 ID。构建失败时先修复可信下载途径，不能为下载开放私人代理或关闭 TLS。只有 `node` 的镜像、宿主已安装的 Claude Code 都不能替代此镜像。自定义镜像见 [setup 参考](setup.md#镜像准备)。

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

如果拒绝，读原因再处理；如果超时或丢回执，使用已打印的核对命令，不重新提交。没有查到记录也不能证明安全重发。文件输入、去重与退出码见[提交参考](submissions.md)。

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

服务不会因提交结束自动退出。停止服务前先用 `list --data "$DATA" --human` 和 `show` 核对执行、工具及停止证据；没有活动或未决执行后，再在终端 A 按 Ctrl+C 结束服务。Ctrl+C、socket 消失或控制服务退出本身不证明 Agent 已停止。未知执行交给[管理员恢复流程](deployment-guide.md#取消与人工恢复)，不要删数据库、锁或强制删除容器来制造结束。

- 找不到 socket：确认终端 A 的实例及 data 路径，客户端不会代启动服务。服务已退出时先用[离线查询](queries.md#离线读取现有证据)，不要仅为看报告而启动可能调度旧任务的服务。
- `start_failed`：先看 show/logs，核对本地镜像、连接支持范围、恰好一个有效认证和容器可达 endpoint。不要贴出 settings 或认证环境，也不要自动换账号。
- 没报告、空报告、`contract: error`：保留 attempt 原始报告与日志，不能把 `completed` 当成功。
- 新问题或新 commit：另行准备输入并显式提交，见[提交参考](submissions.md)。retry 会新建 attempt，不会让原输入自动更新到新 HEAD。

安装、配置、data 和连接文件相互独立，卸载程序不会删除报告或秘密文件。换版、保留与清理见[安装维护](installation.md#资源保留与手工换版)。需要新增业务行为时再读[自定义只读分析教程](readonly-role-tutorial.md)；需要修改代码或发布 Draft PR 的已配置部署，见[管理员高级流程](deployment-guide.md#高级用法issue-到-draft-pr)。

## 验证范围

本教程命令依据当前 CLI/setup、连接投影和 CLI/socket/package 测试，没有新增产品能力。自动化中的受控 provider 或 Docker adapter 不是真实模型。历史指定环境真实 Docker/模型证据见 [#85 验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-85-real-acceptance.md)，正式发布与 demo 见 [#86 验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-86-release-acceptance.md)。

本次文档重写未运行 Docker、读取私人连接或调用真实 provider，未验收你选择的 endpoint、认证、代理路由、镜像和答案质量。setup 成功、静态检查和受控验收均不能补齐这些验证。

## 旧版高级用法入口

<a id="高级用法issue-到-draft-pr"></a>
<a id="每次使用"></a>
<a id="第一步选仓库和-issue"></a>
<a id="第二步读取-issue-内容"></a>
<a id="第三步选择从哪个代码版本开始"></a>
<a id="第四步提交任务"></a>
<a id="第五步保存任务编号查看进度"></a>
<a id="第六步打开并审查-draft-pr"></a>
<a id="常见状态"></a>

旧版 Issue 到 Draft PR 操作及状态说明已保留在[管理员参考](deployment-guide.md#已配置部署issue-到-draft-pr-操作)，不属于本教程只读路线。

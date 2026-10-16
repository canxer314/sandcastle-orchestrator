# 执行级授权连接投影

此入口供已有可信 TypeScript 配置使用，不依赖 setup、安装包或 localhost 桥。继续通过现有 `serve`、CLI/socket `submit --capability ROLE_ID` 和 role/provider 执行，不新增命令。

## 选择来源

```ts
import { claudeCode } from '/absolute/source/src/connection.js';

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

## 优先级与模型

1. 选择 settings 时完全忽略宿主连接环境；选择 environment 时只读该进程白名单。
2. 清除旧 `docker.env` 中的连接、云认证、代理及 Claude 行为字段，再投影所选来源。其他显式容器环境保留。长生命周期 sandbox 不自动注入 `agent.env`。
3. 容器 exec 使用 `env -i`，只保留本次明确环境及 HOME/Git/PATH 设施变量，不继承镜像中旧身份或模型环境。选定来源时追加原生 `--setting-sources ''`，避免镜像、user/project/local settings 再次覆盖。镜像需提供 POSIX sh、env、Git 和 Claude Code；不提供环境清洗回退路径。`--setting-sources` 不控制 managed settings，故容器预检及命令启动检查发现 `/etc/claude-code/managed-settings.json` 或 `managed-settings.d` 时明确失败，不解析、合并或绕过企业策略。请选择独立配置、没有这些 managed settings 的可信镜像；已创建但未启动 harness 的容器保留审计，缺少停止证据仍是 unknown。
4. 来源 `ANTHROPIC_MODEL` 优先于顶层 `model`，后者转换为本次环境中的 `ANTHROPIC_MODEL`。没有两者时由 harness/client endpoint 选择默认模型，不注入项目 Claude 默认值。
5. `claudeCode()` 真正省略 print/interactive 的 `--model`；这是对锁定 Sandcastle 0.12.0 原生 builder 的薄适配，依赖升级须复核命令形状。`claudeCode('backend-model', options)` 保持 Sandcastle 0.12.0 的显式参数、stdin、parser、session 与 options 契约。原始 Sandcastle factory 仍可使用，原显式调用不变。显式模型参数优先于来源模型，字符串原样传递，不维护后端映射表。

CC-Switch 代理只作为 client-facing endpoint。协议转换、动态路由、failover 和实际物理模型归代理，不从本次 client 配置推定实际请求路由。兼容开关和新模型 alias 是否生效取决于镜像里的 Claude Code 版本，不承诺宿主与容器 CLI 相同。

## 支持字段

仅支持 Claude Code 的 Anthropic Messages-compatible endpoint，不限定 Anthropic 模型或上游认证方式。认证是 endpoint 的静态 client-facing API key 或 Bearer token，二者恰好一个非空，这是本投影的冲突限制，不是 harness 官方所有调用的限制。省略 BASE_URL 时使用 harness 原生默认 endpoint；提供时必须为 HTTP(S)，保留路径，拒绝 URL 内嵌认证、query 和 fragment。

明确 env 白名单：

- `ANTHROPIC_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`。
- `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、旧兼容字段 `ANTHROPIC_SMALL_FAST_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`。
- `ANTHROPIC_BETAS`、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`、`CLAUDE_CODE_DISABLE_THINKING`、`DISABLE_INTERLEAVED_THINKING`、`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`、`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`、`ENABLE_TOOL_SEARCH`。

不按前缀放行未知 `ANTHROPIC_*`。字段仅接受无 NUL 的字符串。custom headers 使用逐行 `Name: Value`，拒绝重复名称、控制字符、折行、认证头和 Host/Content-Length/Transfer-Encoding/Connection/anthropic-version/anthropic-beta 冲突。beta header 通过专用字段设置，显式 beta 与禁用实验 beta 同时有效时拒绝。

不支持的有效依赖明确失败，包括 `apiKeyHelper`、云凭据/helper、OAuth/订阅 token、profile/WIF、Bedrock/Vertex/Foundry 等云选择器、host-managed routing、任意 extra body、强制 subagent model、宿主 HTTP(S)/ALL proxy、CA/mTLS 文件与关闭 TLS 校验。不会执行或搬运 helper、认证文件、云凭据，也不会自动单独登录或生成 token。若 live 配置依赖这些项，用户可以另行明确选择独立的容器可用静态连接；程序不自动替他们选择。

## 秘密与运行边界

认证只在运行时注入。Docker argv 使用 `--env NAME`，值经 Docker CLI 子进程环境传递，不写命令参数、配置快照、Prompt 或任务输入。启动/解析错误不带源内容、路径中的敏感值或 Docker 完整命令。日志、模型输出、业务报告、错误、只读工具 observation 和 session 导出在写盘前过滤本次已知 token/key/header 值，含跨 stream chunk 的匹配及 JSON/URL 转义。可执行 capability/publication 工具在入口拒绝含本次已知连接秘密的输入，避免传播到测试产物或外部写入。未匹配的 binary session 原字节保留。

这是防止已知连接秘密意外回显，不是通用 DLP：无法识别模型主动改写、拆分编码的任意秘密，也不清洗用户原有文件、业务仓库或外部 MCP 服务自行保存的内容。不要把认证放进任务输入、角色说明、工具参数或自定义 provider 命令。可信配置代码和镜像仍有权限看到运行时认证；容器进程和获授权 Docker 管理者也可看到，Docker CLI 子进程环境亦可能被有权限的宿主进程检查；Docker 保留容器的 Config.Env 可能持续保留值，管理员核查后负责清理。不承诺完全凭据隔离。

保持只读 repo、权限、目录分离、不挂宿主 home/Docker socket、host 网络禁令和 unknown 审计。允许角色显式使用普通 Docker bridge 出网，不要求新增网络治理设施；确定性测试路径继续禁网。localhost endpoint 不会自动桥接或改写，宿主 loopback 通常不能从容器访问。本票只处理已有容器可达 endpoint。

## 验证范围

`pnpm test tests/connection.test.ts tests/roles.test.ts tests/agent.test.ts tests/management.test.ts` 使用临时 Git repo、真实 CLI/socket、真实 Sandcastle builder/parser、受控 Docker CLI 替身、受控 harness 与本地 HTTP endpoint。它验证每次尝试读取、运行中不重读、模型省略/显式值、字段/冲突/失败、managed settings 拒绝、工具入参保护、只读设施命令及秘密不落 data/log/report/session。fixture 在宿主执行本地 HTTP 调用，不声称证明容器网络可达。

2026-10-16 在另行授权后，以真实 Docker 和原版 Claude Code 2.1.296 完成合成凭据、受控 Messages endpoint 的三次执行，覆盖 live 切换、模型继承/显式 override、容器来源、报告/session 秘密过滤及退出核对。独立命令和证据见 [#80 Docker 验收记录](issue-80-docker-acceptance.md)。`ORCH_REAL_CONNECTION=1 pnpm test tests/real-connection.test.ts` 仅在授权本机 Linux Docker 环境显式运行，默认跳过；需要记录中固定的预部署镜像，不下载或改用其他镜像。测试创建专用 internal network，不使用私人连接或真实模型；如默认地址池耗尽，可由操作者用 `ORCH_CONNECTION_SUBNET` 指定已核对无冲突的小子网。

真实 provider、私人连接、代理路由、localhost 桥及其他镜像/CLI 版本仍未据此验收。历史 #19/#23 特定环境成功记录不替代本增量验收。

依据为 Claude Code 官方 [env vars](https://code.claude.com/docs/en/env-vars)、[model config](https://code.claude.com/docs/en/model-config)、[gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)、[settings reference](https://code.claude.com/docs/en/settings-reference)，以及 [#60 Resolution](https://github.com/canxer314/sandcastle-orchestrator/issues/60#issuecomment-6173989789) 和 [#63 Resolution](https://github.com/canxer314/sandcastle-orchestrator/issues/63#issuecomment-6173205958)。

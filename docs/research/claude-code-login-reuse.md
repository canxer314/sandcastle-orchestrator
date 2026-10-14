# 容器内 Claude Code 可选复用本机登录

研究票 [#63](https://github.com/canxer314/sandcastle-orchestrator/issues/63)，父地图 [#53](https://github.com/canxer314/sandcastle-orchestrator/issues/53)。读取日期为 2026-10-15。项目基线为 `c62a0117fdc504523553b122f4ba1d132b656d87`。本文只记录研究，不决定 setup 默认认证，不实现认证桥。

## 结论

没有找到官方支持的通用接口，可以把 Linux 宿主上已经完成的 Claude Code `/login` 无感转交给本项目的 Docker role。官方明确记录了 Linux 凭据路径，但没有把复制或跨宿主/容器挂载 `.credentials.json` 定义为受支持的登录迁移协议。不能把知道文件位置当成可以正式支持文件复用。[S1][S2]

官方支持两种相邻能力，须分别命名：

- 在容器内用原版 Claude Code 登录，再用独立 volume 和 `CLAUDE_CONFIG_DIR` 保留该容器的登录。它不是复用宿主已有登录。[S2]
- 用户另行授权 `claude setup-token`，生成一年期订阅 OAuth token，通过 `CLAUDE_CODE_OAUTH_TOKEN` 给 CI/脚本或容器使用。它不是导出已有登录，也不是自动刷新已有宿主登录。[S1][S3]

技术支持不等于第三方产品许可。官方禁止第三方应用提供 claude.ai 登录、代用户路由 Free/Pro/Max 订阅请求，以及收集、存储或中转 claude.ai 凭据；同时明确保留终端用户在平台托管的未修改 Claude Code 二进制内自行登录的例外。项目应先确认自身使用方式属于哪一类。不能以官方 Action 支持 OAuth 或 CLI 支持 token 推出本编排器获准代管订阅认证。[S6][S7][S8]

本票没有理由把项目改成 Anthropic API SDK，也不能因为复用未证实就偷偷改用 API key。保留显式 API key、现有 provider 和 gateway。默认认证与是否接受另行生成 token、容器重新登录，由 HITL 接入决策票决定。

## 证据等级和研究边界

下文标记为「文档」的是官方说明，「代码」的是可公开读取的源码或本项目基线，「推断」是工程判断，「未验证」是不在本次授权内的实际行为。

本次只读官方文档、Anthropic 官方公开 GitHub 仓库和项目源码。未读取用户 home 下的认证文件、keychain 或任何凭据值，未运行 Claude/ant 登录、auth status、setup-token、模型请求或容器，未改变登录状态。路径名是官方文档内容，不表示访问了对应文件。

## 已登录状态、Linux 存储与刷新

### 文档事实

[S1] 的 Credential management 原文：

> On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`.

macOS 使用 encrypted macOS Keychain；写入失败时，登录可落到同名 `0600` 文件。Windows 使用用户 profile 下的文件及其访问控制。因此不能用 macOS Keychain 的行为推断 Linux 需要桌面 keyring/Secret Service，当前 Linux 文档明确是文件。[S1]

`CLAUDE_CONFIG_DIR` 会移动 `.credentials.json` 的位置；它也移动 settings、session history 和 plugins。该变量不是只指向一个 secret 的窄接口。[S1][S3]

[S2] 还说明登录状态不只有该文件：

> It stores your OAuth account, personal MCP servers, and per-project trust in `~/.claude.json`, a separate file outside that directory, so mounting a volume at `~/.claude` alone doesn't keep you signed in.

官方容器示例用 named volume 加同路径 `CLAUDE_CONFIG_DIR`，把 `.claude.json` 放入 volume。示例是容器内登录后的持久化，不是宿主 home bind mount。不能只复制凭据文件就承诺完整登录可迁移。[S2][S9]

[S4] 对刷新并发的原文：

> Parallel sessions on one machine share a saved login and coordinate its renewal so that only one process refreshes the token at a time.

该页注明 v2.1.211 之前，休眠恢复可能使两会话用同一 token 刷新，撤销保存的登录。官方确认「同一机器」会协调，但没有确认独立容器、不同路径或文件快照共享同一协调域。[S4]

普通 `/login` 保存的登录可以刷新；临近最终到期三天时有提示；过期且无法刷新后，请求失败，需重新 `/login`。这不是固定一年保证。[S1]

### 推断与未验证

刷新要更新保存的登录，故只能读的 credential bind mount 不能保证跨过刷新；准确写入方式、是否原子 rename、锁文件位置及跨容器兼容性，本次没有公开实现证据，不能承诺。单文件挂载尤其可能与替换文件的写入方式冲突。这是风险，不是已观察到的失败。

复制 refresh token 的快照也不能保证宿主和容器持续同步。可写共享目录会让容器影响宿主登录，且共享配置可能带入 MCP、hooks、plugins、信任状态和会话。即使文件权限和 UID/GID 正确，也没有解决产品许可或刷新协调问题。[S1][S2][S4]

本次读取的官方 `anthropics/claude-code` 仓库公开了容器参考配置、文档入口及其它配套文件，没有提供可用于核实核心 credential loader/refresher 的实现。未使用反编译包、泄漏源码或非官方镜像作证。`.credentials.json` 的内部 schema、refresh lock、Linux keyring 回退、token 导出 API 均未证实。[S9][S10]

## 长期 token 与直接复用不是同一件事

[S1] 的 Generate a long-lived token：

> For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`.

> It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate.

命令会开启浏览器授权流程；用户需批准访问。它没有被描述为从现有凭据文件导出 token。需要 Pro、Max、Team 或 Enterprise 订阅，只能做 model requests，不能建立 Remote Control session 或获取 claude.ai connectors，本地配置的 MCP servers 仍可用。[S1]

环境变量文档要求过期时生成新的 token 并 restart。没有给这个环境 token 提供 refresh token 文件接口，不能把一年期当作无限自动续期，也不能把 `/login` 的刷新逻辑套到它身上。[S3]

`--bare` 不读取 `CLAUDE_CODE_OAUTH_TOKEN`。现有 provider 若启用 bare mode，此候选不适用。不要为研究推定某版本默认是否使用 bare。[S1]

「代码」官方 `claude-code-action` 的 `action.yml` 声明 `claude_code_oauth_token` 是 `anthropic_api_key` 的替代输入，并映射到 `CLAUDE_CODE_OAUTH_TOKEN`。这是官方自动化使用该接口的证据，不是第三方订阅中转的许可。[S8]

另有 Console OAuth profile，无须创建 API key，但它是 Console/API 计费认证，不是 claude.ai 订阅登录。当前文档要求 Claude Code v2.1.242 及以上，profile 默认在 Linux `~/.config/anthropic`，可自动刷新。它改变账号/计费来源，不能替换本票目标。[S1]

## 账号、provider、模型与优先级

「文档」Claude Code 当前支持 Pro/Max、Team/Enterprise、Console、支持的云 provider 及 Claude apps gateway。账号权利、组织政策与所选 provider 都可能限制认证或模型。[S1]

认证优先级不能沿用普通 Anthropic API SDK 的构造器规则。Claude Code 文档列出云 provider、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`apiKeyHelper`、`CLAUDE_CODE_OAUTH_TOKEN`、profiles/federation、保存的订阅 `/login`，其中 active profile 有额外规则，Claude apps gateway 也在列表之外优先选择。`-p` 下存在 API key 时总使用该 key。可选认证不得抹掉已有显式 provider，也不能声称选择 OAuth 后必定计入订阅。[S1]

`ANTHROPIC_AUTH_TOKEN` 是 bearer header 的接口，官方主要用于 gateway/proxy。`apiKeyHelper` 文档描述返回 API key。没有把两者定义为「读取并刷新宿主订阅登录」的官方桥，不能拿它们包装私有凭据文件来规避许可。[S1][S3]

模型仍可由编排器所选 provider 构造命令时传 `--model` 或 `ANTHROPIC_MODEL`。它们是 session 级选择，不改变账号权限。模型别名随版本/provider 变化；固定全名比较适合可重复验收。管理策略 `availableModels`、订阅 entitlement 和 provider 是否提供所选模型仍有效，认证成功不保证任意模型可用。[S5]

版本事实只适用于相应能力，不等于一个整体最低版本：

| 能力 | 官方注明的版本/条件 |
| --- | --- |
| 同机刷新竞态修复 | 文档说明 v2.1.211 之前有休眠后竞态 [S4] |
| Console 无 API key 登录 | v2.1.242 及以上 [S1] |
| startup 到期状态行 | v2.1.210 及以上 [S1] |
| `allowedProviders` 管理策略 | v2.1.285 及以上 [S1] |
| subscription 长期 token | Pro/Max/Team/Enterprise；当前页面未给首次支持版本 [S1] |

没有运行本机 CLI 版本探针，容器镜像内版本也未知。不能用当前网页承诺用户已安装的旧版具备这些行为。

## 第三方 orchestrator 的许可边界

[S6] 的 Authentication and credential use 原文：

> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.

> developers may not collect, store, or intermediate Claude.ai credentials or session tokens

同页要求与 Claude 能力交互的产品/服务，包括 Agent SDK，使用 Console API key 或支持的云 provider。不过它同时说明：

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code

托管原版 Claude Code 的条件包括接受 Commercial Terms of Service、不得修改二进制、不得替终端用户支付/转售/中转 Claude usage、不得移除或限制内置认证方式，每个终端用户使用自己的凭据并由自己的协议计费。[S6]

[S7] 的 Agent SDK 文档更直接：

> Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK.

[S6] 同时写 Pro/Max advertised limits 假定 Claude Code 与 Agent SDK 的 ordinary, individual usage。这说明不能把个人使用一概说成禁止，也不能据此批准一个分发给他人的 SDK 产品。

「未验证」个人自用 orchestrator、组织内部工具，以及通过第三方 provider seam 驱动原版 CLI 是否满足上述托管例外，公开文档没有给本项目具体裁定。`intermediate` 与 `ordinary, individual usage` 也缺少足够具体的界线。Team/Enterprise 未被某句列举，不代表豁免。需确认实际分发、账号归属、secret 的处理主体与组织协议；若无法确认，应向 Anthropic sales 取得书面说明或批准。[S6][S7]

因此候选方案先过许可门槛，再谈技术。不能设计读取宿主 OAuth 后代理 Messages API、伪装官方客户端或跳过授权来满足目标。原版 Claude Code、Claude Agent SDK、Anthropic API SDK 是不同 surface；本项目仍保留自己的 role/provider/container 架构。

## 对照当前项目

「代码」基线 `src/roles.ts:84–119` 使用 `docker.env` 创建 sandbox provider，容器以宿主 UID/GID 运行、root filesystem read-only、`HOME=/home/agent`、home 为 `0700` tmpfs；已存在的 workspace/MCP mounts 为 readonly，默认 network 为 `none`。没有认证 mount、宿主环境全量继承或 login bridge。真实 endpoint 访问还需用户明确授权和外部 network policy。

`src/agent.ts` 只包装公开 `AgentProvider.buildPrintCommand`/`parseStreamLine`，采集 session ID、输出与退出 marker。session capture 不把宿主登录搬进容器。`src/config.ts` 保留 provider seam；本次没有把它改成 Claude Agent SDK 或 API SDK。实际 `claude` 命令和 model 参数由所选 provider 产生，不能因为配置写了 provider ID 就确认镜像 PATH 中有 CLI。

日志完整写入 `stdout.log`/`stderr.log`。在 role 内运行会把 token 打到终端的 setup-token 不满足本票保密条件。当前 `docker.env` 最终以 `--env KEY=value` 加入 Docker CLI argv，也会进入 Docker container config。故「已经能塞 env」不等于有安全 secret 接入；不得把 OAuth 值硬编码到可信 TS config，或把 token 填入 prompt/command/session/data/log。[项目源码]

## 候选方案与最低接入方向

| 候选 | 官方证据 | 与目标差异和处置 |
| --- | --- | --- |
| 直接复制或 bind mount 宿主 `.credentials.json` | 只有存储路径，无迁移协议支持 [S1] | 未证实，不能交付为正式支持；刷新、元数据、权限、共享影响及许可均未解决 |
| 用户另行生成一年 token，容器原版 CLI 读取 `CLAUDE_CODE_OAUTH_TOKEN` | 明确支持 CI/脚本，容器文档也提及 Codespaces secrets [S1][S2] | 最窄的技术候选，但不是直接复用；需许可确认、人类接受重新授权和有限有效期 |
| 用户在容器原版 CLI 内自行登录，独立持久 volume | 官方 devcontainer 模式 [S2][S9] | 不复用宿主；须另行允许交互登录与独立敏感状态生命周期 |
| 用户已有 gateway/provider | 官方显式 provider 入口 [S1][S3] | 保留，不推定该代理接受订阅 OAuth；凭据与上游许可由已有协议确认 |
| 宿主 Claude Code 执行、Remote Control 或自己写 OAuth relay | 不是本项目现有边界 | 不作为本票方案；不能以绕开容器或转调 API 替换需求 |

「推断」若 HITL 选长期 token 且确认许可，最小方向是在现有容器 facility 的启动边界加独立、显式的 runtime secret 输入，不改 scheduler、role 业务或 provider。config 只保留选择和非敏感 secret 引用，值由获准的用户 secret store 在启动时提供，不持久化到项目路径。不继承宿主全量环境，不 mount 整个 home，不读取 `/login` 私有文件，不自动 setup-token。token 到期应明确报错并等待用户重新授权，不能自动 fallback 到 API key 或别的 provider。

这不是已经可实施的 secret transport 设计。必须决定 Docker daemon/同 UID/管理员可见性是否可接受，避免 secret 值出现在 argv、错误文本、审计或 Docker retained-container 生命周期中。容器内模型本身可接触的 env 也不是防泄漏边界。官方警告容器仍可能 exfiltrate 能访问的 Claude Code credentials。[S2] 如果要求 secret 连容器进程和 Docker 管理者都不能看到，目前没有证据证明 env token 候选能满足，不能声称 tmpfs 或脱敏日志已经解决。

「推断」若 HITL 选容器自行登录，应仅用专属用户/账号的认证状态 volume，设置 `CLAUDE_CONFIG_DIR`，不复用宿主 `.claude`。volume 会同时保存其他 Claude 状态，须明确是否允许、访问控制、账号隔离、删除/登出和备份政策。它不应挂在 attempt data/log/session 目录。不能直接把参考 devcontainer 的 NET_ADMIN/NET_RAW 或整体配置搬进当前 sandbox。[S2][S9]

## 需要人类决定的事项

- 「复用」是否必须零重新授权、复用已有 `/login`？如果是，当前结论是未证实官方支持，不能承诺完成。
- 项目是个人自用、组织内部工具，还是面向第三方用户分发的平台？如何满足原版 CLI 托管条件或获得批准？确认前不默认启用 subscription OAuth。
- 若允许替代方式，选择长期 token、容器自行登录，还是保留用户显式 gateway/provider？这不决定 setup 默认项。
- 是否接受 Docker daemon/授权管理员及容器内进程对 credential 的访问范围？采用什么外部 secret store、账号隔离、撤销和 retained-container 清理政策？
- CLI/镜像 pin 哪个版本，测试哪个 plan/account/organization policy，允许运行哪个模型及预算？

## 后续真实验收的授权条件

本次没有真实验收。后续必须另获授权，且先解决许可和 secret transport 决策，使用专用测试账号或明确批准的个人账号、可信测试仓库、指定镜像/CLI版本、模型与花费上限、外部 endpoint-only 网络策略，并说明读取/写入哪类认证状态及如何清理。不得将授权的「研究」视为登录、读取凭据或花钱调用模型的授权。

最小验收应分别验证：

1. 正确启动容器内未修改的 `claude`，保持当前 UID、read-only root、home tmpfs、workspace/MCP 与退出证据边界。
2. 显式选择认证才能访问 secret；无选择时不读取宿主登录。已配置 API key、gateway/cloud provider 不被暗中覆盖。
3. 指定模型确实用于一次获准请求，记录非敏感模型/退出证据，不记录 credential。错误模型或无 entitlement 明确失败，不换模型伪造成功。
4. 配置、Git、data、stdout/stderr、session capture、错误回执、Docker argv/inspect 的已约定范围不存在 secret 值；若 inspect 可见已获准，记录该安全边界而非宣称零泄漏。
5. token 失效/撤销、网络拒绝和 CLI 版本不兼容能明确报告，没有自动认证 fallback。长期 token 不声称自动刷新。
6. 若最终批准「共享已有登录」实验，须先取得官方支持/许可证据，再专门授权宿主写影响和跨容器并发刷新；只验证首次请求成功不能算长期复用验收。
7. 结束后按授权清理容器、独立认证 volume 和临时 secret，确认未影响宿主登录。不得擅自撤销用户主账号或删除其认证文件。

## Primary sources

以下网页均在 2026-10-15 读取；网页内容可能更新，不用抓取日期冒充发布时间。公开代码以 SHA 固定。

- [S1] [Claude Code authentication](https://code.claude.com/docs/en/authentication)，尤其 [Credential management](https://code.claude.com/docs/en/authentication#credential-management)、[Authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)、[Generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)、[Sign in without an API key](https://code.claude.com/docs/en/authentication#sign-in-without-an-api-key)。读取使用官方 `.md` 版本。
- [S2] [Development containers](https://code.claude.com/docs/en/devcontainer#persist-authentication-and-settings-across-rebuilds)，包括安装登录流程、volume 示例、Codespaces token 和 secret exfiltration 警告。
- [S3] [Environment variables](https://code.claude.com/docs/en/env-vars) 和 [CLI reference](https://code.claude.com/docs/en/cli-reference)，`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_AUTH_TOKEN`、`setup-token`。
- [S4] [Troubleshoot installation: Not logged in or token expired](https://code.claude.com/docs/en/troubleshoot-install#not-logged-in-or-token-expired)，同机刷新协调和 v2.1.211 前竞态。
- [S5] [Model configuration](https://code.claude.com/docs/en/model-config)，模型选择、账户权限及管理策略，不将当前别名解析结果写死为项目默认。
- [S6] [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)，同时读取 [Acceptable use](https://code.claude.com/docs/en/legal-and-compliance#acceptable-use) 与 [Can customers offer Claude Code in their products?](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)。这些是官方当前许可解释，不是本项目获得了特批。
- [S7] [Agent SDK](https://code.claude.com/docs/en/agent-sdk#get-started)、[SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#set-your-api-key)。`https://platform.claude.com/docs/en/agent-sdk/overview/authentication` 返回 307 到当前 Agent SDK 页，未发现独立认证页。
- [S8] [Official Claude Code Action action.yml](https://github.com/anthropics/claude-code-action/blob/34968b5981d5d170904281aa3df6f3c0d4a28855/action.yml)，OAuth input 与 runtime env 映射。
- [S9] [Official reference devcontainer.json](https://github.com/anthropics/claude-code/blob/19eb0958df265ee24f59bd25163c175b4c6d4b43/.devcontainer/devcontainer.json)，named volume、`CLAUDE_CONFIG_DIR`，没有宿主登录文件迁移实现。
- [S10] [Official Claude Code repository](https://github.com/anthropics/claude-code/tree/19eb0958df265ee24f59bd25163c175b4c6d4b43) 与 [README](https://github.com/anthropics/claude-code/blob/19eb0958df265ee24f59bd25163c175b4c6d4b43/README.md)。只核实公开内容，不把 issue 评论当正式认证协议。
- 项目源码 [roles.ts](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/roles.ts)、[agent.ts](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/agent.ts)、[config.ts](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/config.ts)。

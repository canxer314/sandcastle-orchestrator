# #85 授权后的真实候选验收

2026-10-17，用户在受控验收交付后明确回复“给你授权，继续吧”。本轮在当前 Linux 主机执行真实 Docker 和既有连接的只读模型问答，不发布包、不改业务仓库、不改变用户正在使用的 CC-Switch 全局 provider，也不修改远端 issue 状态。

## 本次结论

首次本地测试的真实成功、失败、固定 HEAD、dirty 提醒、重复运行、reset 和一次 Ctrl+C 收尾已验证。默认与自定义 init/doctor/demo 均从源码外安装的候选运行。两次 Ctrl+C 正确返回 unknown；之后核实停止的事实不倒算成 CLI 返回时安全停止。

真实 Agent 路径完成 DeepSeek 直连、CC-Switch 转接 ChatGPT、运行中切换临时连接来源及下一次执行、默认继承和显式 model override。自动 localhost 桥经真实容器 harness 使用，原代理仍只监听 localhost，没有人工 relay 或修改 listener。报告回答与固定提交匹配。

这仍是指定主机、镜像和连接的候选验收。后续在隔离 CC-Switch 实例中完成同一执行内 provider 热切换，以及受控 503 后转入真实 DeepSeek 的 failover；用户正在使用的代理配置保持不变。实测确认客户端参数不能固定代理的上游模型。发布渠道和正式首页切换属于 #86。本轮不宣布 #85 所有验收项无条件完成。

## 产物、环境与证据

源码提交 `7823fa9`；使用上一轮已经验收的同一份 `0.1.0` tgz，SHA-256 为 `e762f394887bf61c24bfbe9702e7fc8aa379961aa76ab80b5a7db7e967c9054a`。本轮只补验收文档，没有重新构建产品代码。

- Linux `7.0.0-34-generic`，x86_64，Node `v24.21.0`，npm `12.0.2`。
- Docker client/server `29.8.1`，API `1.56`，本地 rootful bridge。
- demo 镜像 `node:22.22-alpine`，ID `sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd`。
- Agent 镜像 `sandcastle-orchestrator-claude:2.1.296`，ID `sha256:26cf3c761666232a94e467e12b3fe1ecc61b5b4a3346eba1db817ef2b3180939`；实际 `claude --version` 为 `2.1.296 (Claude Code)`。使用现有镜像，没有本轮构建或拉取。
- 新安装 prefix `/tmp/issue-85-real-demo-4YNUxN/prefix`，操作 cwd `/tmp/issue-85-real-demo-4YNUxN/cwd`，隔离 HOME `/tmp/issue-85-real-demo-4YNUxN/home`。Agent 使用先前候选的独立安装 prefix `/tmp/orch-package-c8vgoX/prefix`，cwd `/tmp/issue-85-real-agent-YwAD9r/cwd`。

持久本地归档位于 `/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-85-7823fa9/`，目录权限 0700。保存同一 tgz、`environment.json`、`evidence.tar.gz` 和 `sha256.json`。归档含以下三个目录，不含 node_modules、复制的连接凭据或 Docker Config.Env：

- `demo/`：完整命令、生成配置/仓库、SQLite、demo journal、attempt 日志、容器状态及 `final-closure.json`。
- `agent/`：setup 输出、固定测试项目、执行/报告/日志、harness session 摘要、匹配 session 的代理记录、停止及凭据清理证据。
- `scripts-and-run-logs/`：本轮实际使用的一次性验收脚本、故障 preload、运行日志。脚本引用的临时凭据已删除，重跑需显式提供授权连接，不能直接复制就访问私人连接。

这些原件留在本机，不上传仓库。摘要中的编号均为本轮实际输出。归档哈希见本文件末尾及归档内的 `sha256.json`。

## 安装和真实 demo

安装命令为 `npm install --global --prefix PREFIX --omit=dev --no-audit --no-fund --offline --cache /home/canxer/.npm TGZ`。消费者依赖来自 npm 缓存，不来自开发仓库或全局 pnpm。首次隔离 HOME 下的在线安装等待依赖下载，取消后改用缓存完成；失败尝试未执行任务。npm 阻止 esbuild postinstall，已有平台二进制仍能消费配置，不放开安装脚本权限。

`demo/commands.json` 保存命令 argv、cwd 对应目录、stdout/stderr、退出码。实际顺序是 `--version`、`--help`、`init --yes --json`、`doctor --json`、`demo --json`，然后修改与提交演示仓库、重复 demo、离线查询、reset、自定义目录的 init/doctor/demo。

- 默认成功执行 `ff47fc58-92bd-4a1a-8b6b-8b438007f076`，attempt `eaba5202-03f9-4e19-b4eb-1f663dff208b`，实际 SHA `1d45c8ea2fab3593c11eb8c96d0ca3e4ba20cbec`。退出 0，业务测试通过，Docker inspect 为 stopped，服务 PID 已不存在。
- 将工作区 test.cjs 改为抛错但不提交，执行 `ed25583d-9a18-4ab5-81a4-db293ec4b7ba` 仍测试同一 SHA 并成功，stderr 提醒仅测已提交版本，修改保留。
- 提交失败版本 SHA `2e66de23ca2a6b8de4b009114897cc4dd15eddfd` 后，执行 `53f2f2e9-04de-449b-bcb4-40d44205a398` 退出 1，`testResult=failed`，attempt `53e952f7-b2e8-4494-81fc-e9862cad3a39` 保存真实测试失败日志。执行完成不被当作业务通过。
- 一次 Ctrl+C 执行 `637b4b1a-b037-41fb-9b1f-65df1cf780e4` 退出 130，`executionStopped=true`、`serviceExited=true`，Docker inspect 和服务 PID 缺席分别核实。不是只检查取消回执。
- reset 后离线 list 和既有日志仍保持四条历史。自定义资源执行 `c97ad0e3-ddf6-47d8-867e-62a63adcc385` 成功，默认与自定义 data 独立。

`demo/evidence.json` 保存各次结果、CLI show/logs 及独立容器状态。attempt stdout/stderr 在各 data 的 `attempts/ID/`，服务日志在 `demo-runs/`。`final-closure.json` 独立核对 13 个 journal 对应的服务均已退出，所有已知演示容器均已停止。

## 第二次 Ctrl+C 与故障边界

默认 Node test runner 收到终止信号后很快完成收尾，最初尝试尚未发出第二个有效中断就退出 130，因此不计入双中断覆盖。第二次采用明确的可终止 fixture：生成的确定性配置改为直接执行 `node /workspace/test.cjs`，脚本收到 SIGTERM 后延迟 3 秒退出，最长自然运行 12 秒。没有模拟 Docker 或停止证据。

执行 `79b0fe9c-e9a9-48a7-b8aa-e3895fc9727d` 在确认容器已收到第一次停止请求后，再发送 SIGINT。CLI 退出 2，`status=unknown`、`executionStopped=false`、`serviceExited=false`。随后 Docker inspect 确认自然/协作停止，原服务 PID 缺席，见 `demo/double2-evidence.json`。保留原 unknown journal，不修改记录制造“返回时安全停止”。

安装后的正式命令还使用复制到源码外的现有 `demo-faults.cjs` 注入 IPC/HTTP/时钟故障，Docker、配置、服务、socket、SQLite 和执行本身保持真实。这是混合证据，不能称为真实墙钟等待 5 分钟或真实网络故障：

- `no-ready` 与 `query-stall` 均退出 1、未提交、服务退出，没有执行记录，证明 ready 与只读 socket 查询必须同时成立。
- `lost-receipt` 退出 0，查到唯一接纳记录并完成真实容器测试，没有重复提交。
- `lost-no-match` 退出 2，返回 unknown，下一次 demo 被 unresolved journal 拒绝；离线查询只有一条请求，attempt 停在 starting 且 container 为 null。只核实服务 PID 已退出，未取得该 attempt 的独立停止证据，保留 unknown。
- `execution-timeout` 通过受控时钟越过执行预算，触发取消，退出 1，执行停止和服务退出均确认。该次取消请求时间早于 Docker StartedAt，容器随后短暂启动并退出；它证明预算触发及收尾，不单独证明在长任务运行中到期停止。运行中停止由一次/两次 Ctrl+C 的真实场景另行覆盖。

补充运行中预算场景 `ff29f13d-89bf-4d59-9554-f462559a9866`：容器 StartedAt 为 `2026-10-16T18:31:51.178Z`，取消请求为 `18:31:53.756Z`，FinishedAt 为 `18:31:53.806Z`。该次确认先实际运行再触发受控时间预算，停止由 docker-inspect 确认，服务 PID 已不存在，见 `demo/running-timeout.json`。这仍不冒充真实墙钟等待五分钟。

完整结果位于 `demo/installed-faults.json`。收尾预算、来源限制、背压、断流及取消的全面分支沿用已通过的受控测试；本轮没有把同一秒钟的不同证据混为一谈。

## 真实只读模型与代理

测试仓库固定 SHA `74ba3d3cb9d0d2bc54cb76abfdf5cf90a5aa6e61`，含 README.md、entry.mjs、describe.mjs。答案为 `PINNED_ISSUE_85`，entry.mjs 调用 describe.mjs 导出的 describeProject。提交后将工作区 README 改为 `DIRTY_ISSUE_85`；各次报告引用提交内标记和调用关系，工作区修改保留。提示明确禁止测试、改文件、子 Agent 和网络访问；角色无编排器 tools，镜像及全部 bind mount 只读。没有发布凭据或远端写入操作。

从原有设置中选取 DeepSeek 和当前 CC-Switch 来源，复制到权限受限的临时文件。只使用公开 setup/serve/submit/show 接口。setup 只生成入口，服务与提交随后显式执行。前三次使用同一个服务，验证每次执行重新加载所选来源：

1. `deepseek-inherit` 执行 `921d734e-e8d2-435a-83fc-ff20c68debd4`，attempt `2e199a6d-47d1-4f9c-9da2-4e8f59e7aafb`。endpoint `https://api.deepseek.com/anthropic`，没有 model override；harness 记录 `deepseek-flash[1M]`。
2. 切换临时来源为 CC-Switch，执行 `cd2a73c6-976e-4fb2-828e-2aaa3f07872e`，attempt `73fa7219-6a1a-48a2-9f3f-bc9c644b25e9`。原来源 `http://127.0.0.1:15721` 被自动桥接为本次容器可达的 `http://172.17.0.1:35889/`。执行达到 running 时将临时来源改回 DeepSeek；正在运行的执行仍使用其启动时捕获的代理连接，harness 模型为 `claude-opus-4-8[1M]`。完成后该桥监听端口已关闭。
3. 下一次执行 `98e77573-f144-411d-b549-a70926e156d6`，attempt `84293f5b-5de8-4c1b-acd8-2cb646be07d4`，无需重启服务即使用 DeepSeek，harness 模型恢复为 `deepseek-flash[1M]`。
4. 新的 setup 显式 `--model deepseek-flash`，执行 `191c3f2c-ce19-4cf0-8db6-338a7d29df80`，harness 实际 init 模型为 `deepseek-flash`，覆盖来源默认值。
5. CC-Switch 独立 setup 显式 `--model sonnet`，执行 `6cce5e5b-0c35-4e47-a796-bf9ac91a3ca0`，harness 实际 init 模型为 `claude-sonnet-4-6[1M]`，只读回答通过。

上述五次均 exit 0、contract valid，报告与独立可核对答案匹配；保存 agent-exit-marker 后另用 `docker top -eo pid,comm` 确认无 Claude/Node 进程，才停止本次保活容器和控制服务。固定 SHA 也经容器内 Git 核对。完成后删除这五个已确认停止的容器，避免 Docker 的持久化环境继续保留认证；脱敏 inspect 摘要、marker、报告和日志已归档。

CC-Switch 第一条代理执行的 harness session 为 `75698acb-4025-4b73-9598-077b7075c09f`，与代理数据库中的四条请求匹配。代理记录 provider `codex`、响应模型 `gpt-6.1-sol`、状态 200；显式 sonnet 执行有两条匹配 session 的状态 200 请求。见 `agent/harness-facts.json`。这证明本轮选中的路由和服务端报告，不证明供应商内部物理模型。代理的 model mapping、运行中 provider 变化及 failover 仍由代理决定，编排器只固定本次捕获的客户端参数。

实际凭据字段的字节扫描未在 data、报告、日志或导出的隔离 session 中发现 token/API key。初版扫描把 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 数字也当成“秘密”，产生误报；改按实际认证字段核对后无命中。临时连接副本已删除，用户原始设置和当前 provider 未改动。harness 的美元数字为其估算，不等同账单；本轮未查询或声称已核对 DeepSeek/ChatGPT 实际收费。

## 门禁及剩余范围

本次使用的产品字节与受控验收相同：类型检查通过、低并行全套 401 passed / 22 skipped、最终包消费 17 passed。真实执行补充了上文实际路径，不把默认跳过的全部 opt-in 测试都改称通过。本次只改验收文档，没有重复运行未变的全套。

尚未覆盖真实供应商故障、跨真实历史发布版本、所有可用后端/镜像组合。未知停止仍不能算安全停止。已归档足够证据供分项判断，但不关闭 #85 或父票，不发布 npm/Release，不切换 README 正式入口。

归档 SHA-256：

- `environment.json`：`0d7bf0ab7a77d30098a2e5ce02ba5d89b92af24c3ddaaeeaedef9f59f2c421e4`。
- `evidence.tar.gz`：`2c23a4f1cb55331289741e1885ac9f366ba61d167ebc0375e90dc4988d99b20c`。
- `canxer314-sandcastle-orchestrator-0.1.0.tgz`：`e762f394887bf61c24bfbe9702e7fc8aa379961aa76ab80b5a7db7e967c9054a`。


## 补验：同一执行内代理热切换和 failover

用户要求继续后，以 `ab4398e` 为文档基线，继续使用上述同一候选 tgz 和 Claude 镜像。测试目标为 CC-Switch CLI `5.10.4` 的独立实例，工作目录 `/tmp/issue-85-routing-z1qyty2z`。同时隔离 `HOME`、`CLAUDE_CONFIG_DIR`、`CC_SWITCH_CONFIG_DIR`、`XDG_RUNTIME_DIR` 和 `XDG_STATE_HOME`，使配置数据库、daemon socket、状态及监听端口均不与用户实例混用。独立代理监听 `127.0.0.1:60071`；provider `via-main-proxy` 转接用户既有 localhost 代理，provider `deepseek` 使用授权的真实直连。容器到该独立代理仍由编排器自动 localhost bridge 连通。

公开 CLI 顺序为 `setup --project ... --name routing --connection-settings ... --model sonnet --question ... --yes --json`、`serve`、`submit`、`show`。另一个 `failover` setup 使用相同固定测试仓库 SHA `8d8ca90c1b7c3ac6651e75282cc540760ffe5b50`。仓库包含已提交的 `ROUTING_85` 标记及 entry.mjs → describe.mjs 的 describeProject 调用。完整 argv 和观察条件保存在归档脚本中。

热切换执行 `66a9b1f6-da8b-48bf-bb26-860d95da4544`，harness session `41e6eb3a-5ac4-4b4d-882a-81271c638ef3`。先要求原生 Bash 工具执行 `sleep 4; cat README.md`；观察到该工具调用后，在 `2026-10-16T18:35:50.105Z` 至 `18:35:50.150Z` 之间执行独立实例的 `provider switch deepseek`。同一 session 的第一条代理记录为 `via-main-proxy` / 响应模型 `gpt-6-luna`，后三条为 `deepseek` / `deepseek-flash`，全部状态 200。四条 request_model 均为 `claude-sonnet-4-6`，harness init 为 `claude-sonnet-4-6[1M]`。这直接区分了固定客户端参数和可变代理上游；响应模型仍只是代理记录，不证明供应商内部物理模型。

failover 执行 `e96de3c0-fd96-4934-be81-8f7386025a5a`，session `f8dfd5a2-4222-4da5-a866-a606df4add82`。独立实例切到 `controlled-503`，依次 `failover add controlled-503`、`failover add deepseek`、`failover enable`。本地测试端点累计收到三次 `/v1/messages?beta=true` 请求并返回 503；失败与成功请求在时间上交错，该 session 的三条成功代理记录均为真实 DeepSeek、响应模型 `deepseek-flash`、状态 200；request_model 始终为 `claude-sonnet-4-6`。provider health 记录失败计数 3，但 is_healthy 仍为 1，故不声称触发了熔断。该项是受控故障加真实 fallback 的混合验收，不冒充真实供应商宕机或全部重试策略覆盖。

两次只读回答均包含正确标记和调用关系，exit 0、contract valid、agent-exit-marker 已保存；marker 后 `docker top` 均无 Claude/Node 进程，随后停止各自保活容器和控制服务。热切换场景另有只读根文件系统及全部 mount 为只读的 inspect 原件。两只容器均已删除。独立代理 disable 后端口关闭，daemon 状态为不可达；后续 daemon stop 返回 socket 不存在，未把这次 stop 当作成功停止的证据。用户原始 settings 文件 SHA-256 和当前 provider ID 与运行前完全一致。

扫描 125 个证据/脚本文件，实际认证字段字节未出现在 Agent data、报告、日志或 session 中。脚本内的固定 `issue85-controlled-failure` 是测试端点的合成凭据，单独排除后仍核对真实凭据零命中。独立实例的 private、HOME、配置数据库和代理状态目录已删除，避免保留连接副本；归档只保留脱敏代理请求摘要、执行日志和复验脚本。脚本引用的凭据已删除，重跑需要重新提供授权连接。

本轮持久归档：`/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-85-routing-ab4398e/`，权限 0700。`evidence.tar.gz` SHA-256 为 `4999e3e508f4e5d6d9b8e5fedc36261bb482d62fa648c02f2e122ca37d14f757`；同目录 `sha256.json` 记录基线、候选包哈希和 CC-Switch 版本。`routing/evidence.json`、`routing/failover-evidence.json`、`routing/cleanup.json` 分别保存两次执行和收尾事实。仅补文档，未重新构建或运行未变的产品全套测试；未发布、推送或修改远端 issue。

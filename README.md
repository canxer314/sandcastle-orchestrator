# Sandcastle orchestrator

独立的单机 TypeScript 应用。已交付 [#15](https://github.com/canxer314/sandcastle-orchestrator/issues/15) 的请求提交与查询及 [#16](https://github.com/canxer314/sandcastle-orchestrator/issues/16) 的固定 commit 确定性执行，以及 [#17](https://github.com/canxer314/sandcastle-orchestrator/issues/17) 的外部定时提交与重复送达处理。完整规格见 [#14](https://github.com/canxer314/sandcastle-orchestrator/issues/14)。

## 安装与运行

需要 Linux、Node.js 24+、pnpm 12.3.4 和 util-linux 提供的 `flock`。执行能力还需要本机 Docker daemon、Git 和预先部署的可信测试镜像；不会自动拉取镜像。Sandcastle 固定为 `0.12.0`，Effect 固定为 `3.20.0`，升级需显式更新依赖和锁文件。

```sh
pnpm install --frozen-lockfile
pnpm start serve --data /srv/orchestrator-data --config ./examples/config.ts
```

先修改配置中的 repo 登记和能力定义。配置是管理员部署的可信 TypeScript 代码，启动时加载，不热更新。`version` 填配置仓库的部署 commit，不是任务代码 SHA。输入校验器可以同步或异步执行，以抛出错误或 Promise 拒绝表示拒绝；服务等待校验结束后才保存接纳记录。服务在校验前保存原始输入快照，校验器的返回值或原地修改均不改写接纳或拒绝记录中的输入。旧配置仍有效，没有 `execution` 的能力只接纳排队，不调用 `run`。明确配置 `execution.commit(input)` 和对应环境的 `docker.image` 后，只有新提交自动执行；不完整执行配置拒绝启动服务。示例能力要求完整 SHA，业务脚本为目标 commit 中的 `test.sh`。

运行目录必须专供本应用使用，与配置及目标 checkout 分开，不提交到 Git。启动前检查应用、配置目录和登记的 checkout 路径，拒绝包含关系及符号链接重合，检查失败不修改目录权限。repo 位置当前是本地 checkout 路径。服务将目录权限设为 `0700`，socket 和新建文件设为 `0600`。同一目录只能启动一个控制实例，内核文件锁在服务崩溃后释放。无需也不得通过删除锁文件恢复。

## 提交与查询

CLI 只通过 Unix socket 操作控制服务，服务不可用就失败，不直接打开数据库。所有命令输出 JSON，错误写入 stderr 并返回非零退出码。

```sh
pnpm start submit --socket /srv/orchestrator-data/control.sock \
  --repo example --capability test-commit --input '"0123456789012345678901234567890123456789"' --source manual

pnpm start list --socket /srv/orchestrator-data/control.sock --repo example --status queued
pnpm start show REQUEST_OR_EXECUTION_ID --socket /srv/orchestrator-data/control.sock
```

`--input` 是 JSON，自由文本用 JSON 字符串提交。`--source` 是来源标识，如 `manual` 或外部定时脚本名称，不能放凭据。

直接调用 socket 时，提交必须包含 `input` 字段。缺少该字段是协议错误，服务返回 HTTP 400 和 `Missing input`，不建立请求或执行。`repo`、`capability`、`source` 必须是非空字符串，否则返回 HTTP 400 和 `Invalid repo`、`Invalid capability` 或 `Invalid source`，不建立记录。格式正确但未登记的 repo 或能力仍按普通提交规则保存拒绝原因。显式 JSON `null` 不是缺失字段，会交给能力校验器，并按普通提交规则保存结果。未知命令返回 HTTP 400 和 `Unknown command`，不会按 `show` 查询记录。

合法提交在同一个 SQLite 事务中保存请求和执行，返回 `accepted: true`、`requestId`、`executionId`。无效 repo、能力或输入在数据库可写时保存拒绝记录，返回 `accepted: false`、`requestId`、`reason`，不建立执行。校验器抛错即拒绝，即使错误消息为空，也不会建立执行。拒绝也是已记录的提交响应，退出码为 0，脚本必须检查 `accepted`。必要保存失败返回非零退出码，不返回接纳或拒绝回执。

`show` 可使用请求或执行标识，包含原始输入、来源、计划时间 `scheduledAt`、去重键 `deduplicationKey`、拒绝原因、执行状态和尝试列表。`list` 只列执行，按提交顺序返回，可按 repo、状态和 `--source` 筛选。旧配置和历史 `queued` 记录保持排队，重启不会消费它们。原请求/执行表保留，新增独立尝试表，旧提交、查询协议和回执字段保持兼容。

提交可选 `--deduplication-key KEY` 和 `--scheduled-at 2026-10-11T00:00:00Z`；socket 字段为 `deduplicationKey`、`scheduledAt`。键必须是非空字符串，计划时间必须是带时区的 ISO 时间字符串，畸形字段返回 HTTP 400，不建立记录。同一 `source` 内，同键且 repo、capability、原始 JSON 输入、计划时间相同，返回原有接纳回执；JSON 对象字段顺序不影响比较，数组顺序有意义，计划时间按原字符串比较。不同内容返回 HTTP 400 和 `Deduplication key conflict`，CLI 非零退出，不覆盖旧记录。不同来源互不合并，无键每次新建。去重只登记成功接纳的请求；拒绝记录保留键线索，但不占键。接纳、执行和键登记在同一 SQLite 事务中完成。

旧 CLI/socket 提交无需更改；旧 SQLite 表与记录保留，启动时只新增元数据和去重旁表，历史记录的两个新字段为 `null`。停服务并备份数据库后升级；回退旧程序仍可读写原表，但不支持去重，切勿在回退期间继续投递需要去重的任务。重新升级也不能为回退期间的请求追补键。

外部脚本、cron/systemd timer 配置及补跑边界见 [外部定时提交](docs/external-submission.md)。编排器不重建未收到的触发，不阻止排队重叠，请求去重不保证副作用幂等。

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

## 单角色报告运行（#19，本地实现）

可选 `roles` 定义业务身份：`id`、`description`、`validate(input)`、`buildPrompt({input,repo,actualSha})`、`skills: string[]`、`tools: string[]`、`validateReport(report)`。工具 ID 引用可选 `tools: [{id,description}]` 中的已部署工具说明，不另建通用工具框架。`providers: [{id,agent}]` 接受公开 Sandcastle `AgentProvider`；`roleBindings: [{role,provider,environment,commit(input)}]` 将角色绑定 provider/环境与完整 SHA selector。同一角色可提交到不同登记 repo，用现有 `--capability ROLE_ID`，没有 binding 的角色只接纳排队。角色和确定性 capability ID 不可重名，旧配置无需新增字段。

角色 Prompt、skills/tool 说明、配置版本、provider/environment 身份与固定 SHA 在模型启动前必要保存，配置不热更新。输出格式由角色负责：`validateReport(output: string)` 接收真实文本，可直接返回文本或自行解析 JSON，并返回可 JSON 保存的业务报告；抛错表示返回契约错误。运行 error/exit code 与报告契约分别保存，非零退出的有效报告不会被丢弃。`show` 保存输出、迭代/session 引用、exit code、报告与契约状态；正常 CLI 退出不代表业务成功，不把建议转为请求。每次 retry 新目录、新 `orch/ATTEMPT_ID` branch、新 session，不 resume/fork。session 导出通过 `docker exec -i CONTAINER cat -- PATH` 流式写入宿主文件，兼容 `/home/agent` tmpfs，不依赖无法读取该挂载内容的 `docker cp`；文件导出不使用 8 MiB 命令缓冲，非零退出或宿主写入失败仍按 session capture 失败记录。

只读报告设施从本地 repo 创建独立无 remote clone，拒绝 symlink/submodule 与目标树 `.sandcastle/.env`；不挂载原 checkout、宿主 home、Docker socket或凭据。public `createSandbox` 创建专用 worktree，薄 `createBindMountSandboxProvider` 将代码/Git metadata 全部 readonly 挂载，root filesystem readonly，只有隔离 `/tmp`、`/home/agent` tmpfs 可写；Git setup 写隔离 home 的 global config，repo保持只读。管理员配置可信预部署 `docker.image` 与可选 `docker.env`、`docker.network`（默认 none，不允许 host），模型认证仅用专用授权凭据，绝不注入宿主环境或 GitHub 写凭据。provider 的 `agent.env` 不自动注入长生命周期 Sandbox，应明确在环境中配置。环境值不保存配置快照，但日志/模型输出不做秘密过滤。当前报告设施不提供写 repo 的业务角色。

不使用内置 SDK Docker provider：0.12.0 的 shutdown hook 在 exit/SIGINT/SIGTERM 调用 `docker rm -f`，没有公开 opt-out，违反未知状态不强杀。这里不注册这种 hook、不调用 SDK close/abort、不自动清理容器。管理员须在核查结束后清理保留容器。角色取消先保存协作意图，再向仅本 attempt 的目录发布 stop 文件，readonly 挂载 `/orchestrator-stop/requested`，Prompt 要求定期检查并及时返回；通知失败及必要保存失败可查询，不 close/kill，也不保证 Agent一定响应。原运行得到 CLI exit evidence 后可保存 cancelled。未知状态仍须人工确认停止后恢复。

`Sandbox.run` resolve 与模型文本都不能证明退出。公开 provider command 外包 subshell，在 CLI 实际结束后写随机 exit marker，stream parser 精确识别该 marker，保留原 stdin/parser/session 契约；marker 缺失保持 unknown。该证据用于可信设施中的生命周期观察，不是抵抗恶意容器/模型伪造的安全认证。显式 `idleTimeoutSeconds: Infinity`、`completionTimeoutSeconds: Infinity`、`completionSignal: []`，不增加 token/费用/turn 预算。Git setup/commit collection 沿用 SDK 10s/30s 真实设施超时；Docker启动与管理员工具各自负责超时，编排器不强杀。

2026-10-11 已在授权环境完成真实只读单角色运行与人工 retry，通过 Claude Code → CC-Switch → Codex OAuth 路径验证挂载、认证、报告、session 导出和退出证据，详见 [验收记录](docs/issue-19-real-acceptance.md)。此结果不代表其他 provider 或真实协作取消响应通过；并发调度 #20 不在本实现范围。

## 取消与人工恢复

重启不消费历史 queued 请求，也不重跑、重连或接管旧 starting/running 尝试。`show` 的 `location` 如实返回容器名；harness process identity 和 reconnect handle 不可得时为 `null`，不能据此声称已停止。

```sh
pnpm start cancel EXECUTION_ID --socket /srv/orchestrator-data/control.sock --reason '停止该请求'
pnpm start confirm-stop EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已在 daemon/宿主核查停止' --reason '控制服务中断'
pnpm start resolve EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对并保留外部结果' --reason '结束未决' --external-results '相关外部结果及核对证据'
pnpm start retry EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对，允许再次执行' --reason '重新执行' --external-results '相关外部结果及核对证据'
```

socket 对应命令为 `cancel/confirm-stop/resolve/retry`，使用 `id`、`reason`，人工操作还需 `source/handling`，resolve/retry 还需 `externalResults`；全部输出 JSON。`--attempt` 只能指定当前尝试，日志/产物仍可选择历史尝试。

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

`examples/query-attention.ts` 是只读外部脚本，调用现有 CLI 的 `list` JSON。成功输出单行 `{version:1,available:true,items:[...]}`，退出码 0，无待处理项时 `items:[]`。每项只含 `requestId/executionId/status/attemptId/reasons`，不转发 repo 名称、输入、错误文字、日志、环境变量、business 或人工处理文字。`reasons` 是 `failed`、`needs_attention`、`stop_unconfirmed` 的组合。脚本检查启动失败、契约错误、unknown/必要保存失败以及有取消意图但没有停止确认的尝试；正常 queued、静默 running 不告警，排队取消没有底层尝试也不算未确认停止。无尝试的启动前失败仍显示 `start_failed`，对应 `execution_failure` 服务日志；可核查配置后人工 retry。脚本查询有 30 秒超时及 16 MiB 输出上限，只约束查询，不约束执行。socket 不可用、CLI 失败、输出解析失败或达到上限，stdout 为空，stderr 单行 `{version:1,available:false,error:"Control query failed"}`，退出码 1。不能把失败当成正常的空列表。

详情提供原始请求、尝试、配置版本、实际/选定 SHA、时间、失败原因、日志/产物引用及人工核对的外部结果。原始输入、日志、模型报告和外部结果可能敏感，只在受限环境查看。管理员按能力所用设施核对远端结果，不从模型文字推断成功。`location.container` 可用于 `docker inspect --format '{{json .State}}' NAME` 和 `docker logs NAME`；`processIdentity/reconnectHandle:null` 表示没有可靠宿主进程身份或重连句柄，不能用猜测的 PID 杀进程。名称是定位信息，不是停止证明。还需核对宿主入口、子 Agent、工具和远端操作。控制服务或主 Agent 退出、取消回执、单个容器退出都不证明全部停止。

服务日志写 stderr，交给 systemd journal 或现有日志采集设施。JSON 包含 `time/event/error`，后台执行错误另含 executionId。事件有 `service_failure`、`service_crash`、`execution_failure`、`execution_failure_save_failed`、`management_failure`。服务日志只记录固定安全错误摘要，不写任意异常消息、stack、认证头或完整环境。已知启动校验错误保留安全分类，其他异常显示 `Control service failed`，管理员结合配置部署版本、journal 时间和受限运行记录定位。失败记账本身失败时服务日志仍有证据，但数据库可能暂留 queued，不能仅凭查询宣称没有故障。SIGKILL、断电无法由被杀进程写日志，由进程管理器的退出记录发现。

可由 cron/systemd timer 在应用安装目录运行查询。通知桥只接收上述摘要，渠道凭据由管理员放在桥自己的受限文件中，不写命令参数或通知内容。以下接法要求 `jq` 和管理员现有的 `notify-summary` 工具，不附带发送实现，也不运行真实通知。

```sh
umask 077
summary=$(mktemp)
trap 'rm -f "$summary"' EXIT
if node --import tsx examples/query-attention.ts --socket "$DATA/control.sock" >"$summary"; then
  if jq -e '.version == 1 and .available == true and (.items | length > 0)' "$summary" >/dev/null; then
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

本版本没有批量清理命令。普通清理不能按目录年龄、无输出、控制进程退出或取消意图删除活跃/未确认尝试。先核对执行、尝试、停止证据和外部结果，再单独清理已确认结束的设施；保留人工恢复需要的记录、日志和产物。不要使用 `docker container prune`、`docker rm -f` 或批量 `rm` 绕过这一步。DATA 根目录 0700、socket/新建文件 0600；已有文件权限不会自动递归修复，管理员可用 `stat` 核验，并在停止服务且核查执行后按存储策略处理。不要 `chmod -R` 正在运行的 workspace。备份、导出的日志/产物和通知暂存也须限制权限、访问人员及保留期。日志/产物不是秘密过滤器，脱敏后才可分享，发现凭据泄露先撤销凭据再按授权清除敏感副本。

## 验证

```sh
pnpm test
pnpm run typecheck
pnpm audit
```

管理测试经真实 CLI/socket 启动控制服务，用临时 SQLite 和文件系统验证提交、拒绝、查询、事务失败、服务独占、崩溃恢复和文件权限。`tests/execution.test.ts` 的真实 Docker 用例默认 skip，仅在已获授权主机显式 `ORCHESTRATOR_REAL_DOCKER=1 pnpm test` 才执行。它们使用临时 Git repo 和本地 `node:22.22-alpine` 镜像执行真实无网络 Docker 脚本，验证固定 SHA、独立目录、非零业务结果、日志/产物与隔离限制；需要管理员授权的测试主机和预部署镜像，缺镜像/daemon 时测试失败，不下载或绕过。SQLite trigger 故障注入验证启动前与结束保存失败，受控 Docker CLI 替身验证 client 退出但容器仍运行或 inspect 不可得的未知结束窗口，Git adapter 替身验证明确禁用 lazy fetch。未运行真实业务项目、模型、MCP 或外部写入，未验证任意镜像安全和内核级隔离。

后续实现沿用这一管理入口，按 #19–#29 增加能力与验收。本版本没有自动恢复、Agent 调度、保留清理或备份管理，不应按完整生产规格部署。

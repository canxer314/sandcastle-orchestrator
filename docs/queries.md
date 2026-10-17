# 查询任务、排查失败与取消恢复

本页是日常查询参考。先按[主教程](user-guide.md)提交只读模块分析，再带相同 data 和真实编号查询。安装用户使用正式命令，不需要源码或 pnpm。show、list、logs 支持在线与离线查询，artifact、maintenance 仅支持在线查询。

## 选择实例与输出

查询默认 JSON，不随 TTY 改变。显式 `--human` 才输出可读格式，与 `--json` 互斥。新选项严格拒绝额外位置参数和无关参数；不使用新选项的旧调用仍保留既有容忍行为。管理写命令的 human 回执和文件/stdin 输入见[提交与可靠回执](queries.md#提交任务并保留回执)。`serve --human` 明确拒绝，ready JSON 与 stderr 服务日志不变。

查询未指定 socket 时使用所选 `--data` 内的 `control.sock`，默认 data 为 `~/.sandcastle-orchestrator/data`。显式 `--socket` 优先；同时显式给 data 时，必须指向该 data 的同一个物理 socket，符号链接别名可用。相对路径按当前目录解析。查询不会为了猜 socket 加载 `--config`，也不会启动服务。使用新模式/选项的写命令沿用上述实例选择；旧写调用仍须显式提供 `--socket`。

```sh
sandcastle-orchestrator list --data /srv/orchestrator-data --human
sandcastle-orchestrator show EXECUTION_ID --data /srv/orchestrator-data --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --attempt ATTEMPT_ID --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --attempt ATTEMPT_ID --call 1 --human
sandcastle-orchestrator artifact EXECUTION_ID --data /srv/orchestrator-data --name report.txt --human
sandcastle-orchestrator maintenance --data /srv/orchestrator-data --human
```

用实际返回的编号替换占位符。`show` 分开展示接纳、执行状态、实际 attempt、业务原文或结果引用与证据缺口。`completed` 或任意 `passed` 字段不构成通用业务成功判断。`list` 只列有关联执行的记录，带 repo、状态和待核对提示。`logs` 默认最新 attempt，保留 attempt/call 选择、缺失、清理、截断和完整性信息。每个日志流最多返回末尾 64 KiB。artifact 保留原 base64 内容和分段元数据，不自动解码或声称产物完整。

human socket 查询最多等待 30 秒，包含接收响应的时间。超时退出 1，可用同一实例和编号重新查询。Ctrl+C 退出 130，只停止客户端等待，不取消执行。查询成功为 0，即使查到业务失败或 unknown；普通读取或协议错误为 1。旧 JSON 的等待规则和退出码不变。

## 丢失回执时按来源与键查证

```sh
sandcastle-orchestrator show --source webhook --deduplication-key delivery-1 --data /srv/orchestrator-data --human
sandcastle-orchestrator show --source webhook --deduplication-key delivery-1 --data /srv/orchestrator-data --offline
```

source 与 key 必须成对提供，不能同时给请求或执行编号。JSON 始终为数组，即使只有一项。每项包含 `accepted`、`request`、`execution`、`attempts`，按请求记录顺序返回全部匹配项，含拒绝记录。拒绝不占接受去重键，同组可能先拒绝多次再接纳。按编号的旧响应仍只有 `request`、`execution`、`attempts`。

空数组只说明尚未查到受理记录，不证明可以安全重发。查询不会调用 submit，也不会自动重发。source 不是认证身份。

## 离线读取现有证据

```sh
sandcastle-orchestrator show EXECUTION_ID --data /srv/orchestrator-data --offline --human
sandcastle-orchestrator list --data /srv/orchestrator-data --offline --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --offline --human
```

`--offline` 仅支持 show/list/logs，与显式 socket 冲突。默认仍输出 JSON。它只读 `DATA/records.sqlite` 和所选日志，不加载 TypeScript 配置、不依赖 init 标记、不创建目录/库/表、不迁移、不补标记、不写状态，也不启动服务。缺失或不支持的记录结构明确报错，保留原件；读取错误不等于数据损坏。

支持当前既有 requests、executions、attempts、submission_metadata、execution_management 表结构和 DELETE journal 模式。不要求 maintenance 或接受去重映射表。缺少查询所需表的更旧数据明确拒绝，离线不会执行在线启动时的兼容补表。WAL 或非空 journal 会拒绝读取，避免创建共享内存或触发恢复、忽略尚未合入主文件的记录。不要删除 sidecar 绕过错误，保留现场并交由管理员核对。

离线 starting/running 只是最后持久化状态，当前活动未核实。对应 attempt 的 JSON 带 `activityVerified: false`，不会回写 unknown，也不宣称仍运行或已经停止。在线启动后的 unknown 投影和既有人为停止确认、审计、恢复含义保持不变。

SQLite 只读事务保证数据库查询的一致视图，不冻结外部日志；并发清理、写入或文件缺失仍可能使证据不完整。离线产物查询未提供，业务结果引用可用于人工定位保留文件。不要只为看结果而启动可能调度遗留任务的服务；先核对实际进程、容器与外部副作用，再按既有维护/恢复流程处理。

查询返回已有记录，不检查模型认证、容器当前活动或生产外部结果。受控 CLI/socket 测试不替代真实 provider 验证；离线结果尤其不能证明仍在运行或已经停止。

## 阅读只读模块报告

setup 生成入口的 `show --human` 直接显示可读报告，或给出大结果引用。完整原文在实际 attempt 的 `artifacts/report.txt`，以实际 location 为准，不要猜编号。核对实际 SHA、问题、文件引用与缺失证据；非空文本的 `contract: valid` 不保证答案正确。它没有执行测试，不能据报告自述宣称测试通过。

`artifact` 即使加 `--human` 也保留 base64 与分段信息。下面读取完整的小报告，核对可用性后解码，不执行报告内容。未指定 offset 时，成功响应直接包含全文，不带 complete 字段：

```sh
sandcastle-orchestrator artifact EXECUTION_ID --data /actual/project/data --name report.txt |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);if(r.availability!=="available"||r.encoding!=="base64"||typeof r.content!=="string")throw Error("Report unavailable; inspect show and artifact response");process.stdout.write(Buffer.from(r.content,"base64"));});'
```

产物默认上限 8 MiB。超限时用 `--offset 0`，按 `nextOffset` 逐块查询到 `complete:true`，不能把首块当完整原文。多次尝试用 `--attempt ATTEMPT_ID` 选择对应日志或产物；大业务结果可通过 `businessReference` 指向的 `business.json` 读取。

## 提交任务并保留回执

安装用户直接使用 `sandcastle-orchestrator`，不需要源码或 pnpm。第一次只读分析请按[主教程](user-guide.md)操作。以下命令使用已配置的 repo、capability 或 role ID，不从 cwd 或唯一配置猜目标。repo ID 不是 checkout 路径，source 是来源标识，不是认证身份，不能放凭据。

## JSON 参数、文件或 stdin

三种输入任选一种，只解析 JSON，不执行文件。不新增通用 `--sha`，输入 schema 和固定版本选择由 capability/role 负责。

```sh
sandcastle-orchestrator submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual \
  --input '"0123456789012345678901234567890123456789"'

sandcastle-orchestrator submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual --input-file input.json

cat input.json | sandcastle-orchestrator submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual --input-file -
```

使用实际配置中的 ID 和输入替换示例。`--input` 与 `--input-file` 互斥；空输入、非法 JSON、文件读取错误、缺少必要参数和不支持的参数组合都在发请求前退出 1。新模式/选项严格拒绝额外位置参数、无关参数和 offline 写入。`--scheduled-at` 仍只是元数据，不是启动计时器。

管理命令默认 JSON，不按 TTY 切换；显式 `--human` 与 `--json` 互斥。JSON stdout 只包含机器结果，诊断和进度在 stderr。`serve` 保留 stdout ready JSON 和 stderr 服务日志，拒绝 `--human`。旧调用不使用新选项时保留参数容忍、等待和退出码，包括 `accepted:false` 仍为 0。JSON 文件/stdin 提交也不自动补 key，不增加 human 等待上限。

## 接纳不等于执行成功

submit 仍异步，只等待接纳回执，不等待执行，不自动启动服务。human 回执给出实际 request/execution ID 及下一条 show 命令；拒绝回执显示实际 request ID 和原因，退出 1，不伪造 execution ID。相同 source/key 的相同提交可能返回原 execution ID，接纳不代表创建了新执行。键内容冲突是明确错误，不应更换 key 后盲目重发。

`submit --human` 未给 `--deduplication-key` 时，每次独立调用生成一个新 key。在发出请求前，将 source、key 和可执行只读查证命令写到 stderr。显式 key 原样使用，JSON 不生成 key。同一次调用不会自动重发。保留 stderr 提示，尤其是尚未拿到 execution ID 时。

查询及新模式/选项写命令默认使用所选 `--data/control.sock`，data 默认 `~/.sandcastle-orchestrator/data`。显式 socket 优先；同时显式给 data/socket 时必须对应同一物理 socket，符号链接别名可用。相对路径按 cwd 解析，不加载配置猜 socket。旧写调用仍须 `--socket`。提示命令保留本次 data/socket，不会悄悄查询默认实例。连接失败时，先核对目标实例，再显式使用自己的 data 和可信 config 启动 serve；客户端不会代为启动。

## 回执不确定时只读核对

human 写操作最多等待 30 秒，包括持续接收响应的时间，只限制客户端。断线、超时、无法确认的回执或 Ctrl+C 都不会撤销操作，也不会自动重发。

| 情况 | 退出码 |
| --- | --- |
| human 已确认成功回执 | 0 |
| human 明确拒绝、连接未成功或普通错误 | 1 |
| human 已发出写操作，结果未确认 | 2 |
| human 在发送前中断客户端等待 | 130 |
| 旧 JSON 接纳或拒绝回执 | 0，必须检查 `accepted` |

2 优先于中断状态。日常 Ctrl+C 只停止客户端等待，不自动 cancel。查询中断为 130；查询到 failed 或 unknown 仍为查询成功 0，详见[查询与离线查证](queries.md)。

submit 回执丢失时，使用发送前保存的 source/key 和原实例，只读核对全部请求。用实际值替换占位符：

```sh
sandcastle-orchestrator show --source SOURCE --deduplication-key KEY --data /srv/orchestrator-data --human
sandcastle-orchestrator show --source SOURCE --deduplication-key KEY --data /srv/orchestrator-data --offline --human
```

source/key 查证会包含拒绝与接纳记录。没有匹配只表示尚未查到记录，不证明可以安全重发。离线命令必须使用已知对应的 data，不能从任意自定义 socket 位置猜 data，也不能携带 `--socket`。不要只为查记录而启动可能调度历史任务的服务。保留现场，按实际进程、容器及外部副作用人工核对。

## 其他管理写命令

`cancel`、`confirm-stop`、`resolve`、`retry`、`cleanup`、`pause`、`resume`、`restore-review` 均支持 `--human`，与 submit 使用相同的客户端等待及退出码规则。原审计字段、人工停止确认和恢复限制不变。每个命令的必填字段见 `sandcastle-orchestrator COMMAND --help`。

```sh
sandcastle-orchestrator cancel EXECUTION_ID --data /srv/orchestrator-data --human --reason 'operator requested stop'
sandcastle-orchestrator pause --data /srv/orchestrator-data --human --source operator --reason 'backup window'
sandcastle-orchestrator cleanup --data /srv/orchestrator-data --human
```

cancel 回执只证明取消请求已接纳，不证明执行已停止。confirm-stop 只记录人工独立核对结果，不负责停止进程；resolve/retry 仍要求停止证据和外部结果审查，retry 不等于恢复旧工具位置。pause 不停止已有执行，restore-review 不自动 resume。cleanup 回执保留每项清理状态和原因，不能把 partial 或 unknown 当作全部清理成功。

无提交 source/key 的管理写操作不虚构 key。回执未确认时，按已知 ID 给 show 指引；pause/resume/restore-review 给 maintenance，cleanup 给 list，均保留同实例选择。cleanup 的 list 仅用于定位执行，需再查 show/logs 的实际证据与清理状态。

提交回执只证明受理结果，不证明 Docker、模型或外部写入成功。受控 CLI/socket 测试不替代真实 provider 验证；结果与停止证据须用实际编号继续核对。

## 取消执行并人工恢复

先用 `list --status` 找到执行，再 `show` 检查当前 attempt、状态、`actualSha`、日志、容器名、工具调用和外部副作用。管理 CLI 参数以当前 parser 为准：`cancel` 需要 `--reason`；`confirm-stop`/`resolve`/`retry` 需要 `--source`、`--handling`、`--reason`；`resolve`/`retry` 还必须有 `--external-results`。处理说明必须写实际核对结果，不要填模板文字冒充证据。

```sh
sandcastle-orchestrator list --socket "$DATA/control.sock" --repo approved-repo --status unknown
sandcastle-orchestrator show "$EXECUTION_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator logs "$EXECUTION_ID" --socket "$DATA/control.sock" --attempt "$ATTEMPT_ID"
sandcastle-orchestrator cancel "$EXECUTION_ID" --socket "$DATA/control.sock" --reason '说明取消原因'
```

取消只提出协作停止请求，不证明容器、Agent、子进程或远端工作已经停止。先按 `show` 中容器定位到实际 daemon，检查 `docker inspect` 的真实状态、入口及工具执行、服务日志和外部系统结果；缺证据就让它保持 `unknown`，不要 retry。**不要在未独立核查前运行 `confirm-stop`，也不要 kill harness、控制进程或容器来制造停止结论。**

确认所有相关执行确已停止后，人工记录核查依据：

```sh
sandcastle-orchestrator confirm-stop "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写实际停止核查方式和证据' \
  --reason '填写确认原因'
```

`confirm-stop` 只是记录操作者确认，不替代核查，也不自动结束 unknown。核对旧外部副作用后，才可以二选一：

```sh
sandcastle-orchestrator resolve "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写已完成的核对和处理' --reason '说明为何结束未决状态' \
  --external-results '填写实际外部结果及证据'

sandcastle-orchestrator retry "$EXECUTION_ID" --socket "$DATA/control.sock" \
  --source operator --handling '填写已完成的核对和处理' --reason '说明再次执行理由' \
  --external-results '填写实际外部结果及证据'
```

`retry` 会建立新 attempt，不复用旧日志或目录；若需求或基线变了，提交新请求而非 retry。清理只通过管理入口，且须满足保留条件；不要用 `docker rm -f`、`docker prune` 或批量删除替代核查。

进一步的提交字段、状态含义、备份恢复、日志/产物限制见本页；旧管理命令默认输出 JSON，显式 `--human` 提供可读结果；init/doctor/demo/setup 默认可读，支持 `--json`。退出码和不确定回执见[提交指南](queries.md#提交任务并保留回执)，不能仅看退出码判断受理或业务成功。妥善保护输入、配置、报告和日志，其中可能包含敏感数据。

## 识别停止证据和恢复限制

重启扫描可执行的历史 queued 主 Agent 请求，历史确定性请求仍保持排队；不会重跑、重连或接管旧 starting/running 尝试。`show` 的 `location` 如实返回容器名；harness process identity 和 reconnect handle 不可得时为 `null`，不能据此声称已停止。

```sh
sandcastle-orchestrator cancel EXECUTION_ID --socket /srv/orchestrator-data/control.sock --reason '停止该请求'
sandcastle-orchestrator confirm-stop EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已在 daemon/宿主核查停止' --reason '控制服务中断'
sandcastle-orchestrator resolve EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对并保留外部结果' --reason '结束未决' --external-results '相关外部结果及核对证据'
sandcastle-orchestrator retry EXECUTION_ID --socket /srv/orchestrator-data/control.sock \
  --source operator --handling '已核对，允许再次执行' --reason '重新执行' --external-results '相关外部结果及核对证据'
```

socket 对应命令为 `cancel/confirm-stop/resolve/retry`，使用 `id`、`reason`，人工操作还需 `source/handling`，resolve/retry 还需 `externalResults`；全部输出 JSON。`--attempt` 通常只能指定当前尝试；工具停止确认和日志/产物可选择历史尝试。

不传 `--call` 的 confirm-stop **只确认 parent attempt**，不会推断或追溯确认工具停止。对每个仍未决、需核查或停止未确认的 `toolCalls`，先实际核查工具容器及外部结果，再运行 `confirm-stop EXECUTION_ID --call CALL_ID --source operator --handling '工具停止核查方式' --reason '停止依据' --external-results '外部结果核对证据'`（同样传 `--socket`；历史工具加 `--attempt ATTEMPT_ID`）。socket 使用可选字符串 `call`、`attempt` 和必填 `externalResults`。确认不停止工具，也不重写其原 `runState/error/requiresAttention/persistenceError`；只增量保存工具 `stopConfirmation.kind: manual` 审计。任何入口仍 live 时拒绝人工确认。

所有待核对工具分别确认后，resolve/retry 才能事务保存工具 `reconciliation` 并结束未决或创建替代尝试；父退出或父人工确认均不能绕过。旧程序留下的 resolved/completed parent 与 unknown 工具也可先明确确认工具，再 resolve。确认后但尚未 resolve/retry 时仍保护证据。

取消首先事务保存意图；无尝试的 queued 直接 cancelled。运行尝试后台调用 `docker stop --timeout -1`，只协作停止，不使用默认超时后的 SIGKILL，不强杀 harness/client。管理回执只证明取消意图已保存。协作停止可能无限等待，状态保持 unknown；stop 失败、无可用容器身份或 inspect 不可得也不宣称停止。只有 inspect 确认非运行且本实例 capability 入口已结束，才能保存 cancelled + `stopConfirmation.kind: docker-inspect`。已退出的前一容器不证明宿主入口结束；入口仍 live 时保持 unknown，人工 confirm-stop/resolve/retry 也不能绕过。stop 失败后，原命令正常退出的可信 inspect 加入口结束仍可完成取消。完整 completed 不被后来的取消覆盖，取消不回滚外部写入。

人工 confirm-stop 只记录恢复者的来源、处理方式和原因，标记 `kind: manual`，不冒充独立验证。确认停止仍保留 unknown；resolve 才结束未决。任何未确认停止的旧尝试阻止替代尝试。保守要求每次 resolve/retry 都记录外部结果和处理说明；编排器不核验所有远端事实，恢复者必须先实际核对再操作。retry 在原 execution 下新增尝试，保留旧记录及目录、日志/产物，使用当前部署配置。选定的完整 SHA 在创建尝试同一事务中必要保存，之后再验证 Git 实际 SHA；必要保存失败不启动。已存在实际 SHA 时固定该 SHA，即使当前 commit 解析配置改变；实际 SHA 尚未保存时沿用原选定 SHA。旧历史尝试既无实际 SHA 又无选定 SHA 时拒绝 retry，不能重新调用当前 selector 猜测原基线；核对后只能提交明确的新请求。原需求或基线变化应 submit 新请求。新尝试没有恢复内部工具位置；晚到旧尝试回调不能改写已处理旧尝试或新尝试状态。

### 存储升级与回退

自动增量创建 `execution_management` 表并扩展 attempts 的 JSON facts，不删除或修改旧表列；旧记录无新字段也可读写。升级前停止服务、核查底层容器并备份完整 DATA（SQLite、attempts 目录），不要仅备份数据库。旧二进制能读取新增字段但不理解取消、恢复及固定重试基线语义；存在新状态或多尝试时不能直接降级继续执行。回退应停止新服务并确认底层停止，恢复升级前完整备份，再部署旧版本；恢复备份不撤销外部副作用，必须人工核对，避免重复提交。

## 常见状态

- `queued`：已接纳并排队，尚未开始；可稍后再次 `show` 查询。
- `starting` / `running`：正在准备或运行；等待后再查询，不要重复提交。
- `completed`：入口已结束；检查业务报告、测试结果和 Draft PR 回执，不能只凭此状态判断任务成功。
- `unknown`：执行或外部结果未能确定。停止继续提交和 retry，保留 `executionId` 并联系管理员核查；盲目重试可能重复外部写入。
- 未知状态、拒绝原因不明、服务不可用或没有 Draft 链接：把 `executionId` 与回执交给管理员，不要自行盲目 retry。

管理员负责配置和恢复；需要首次部署、授权边界、故障核查或备份恢复时，请看[部署与运维指南](deployment-guide.md)。

## 对接 socket 和稳定去重

`--input` 是 JSON，自由文本用 JSON 字符串提交。也可用 `--input-file PATH` 读取文件，或 `--input-file -` 读取 stdin，不能与 `--input` 同用；只解析 JSON，不执行内容。repo 是配置中的 ID，不是 checkout 路径；capability 也可选择 role ID，两者与 source 都必须明确提供。`--source` 是来源标识，如 `manual` 或外部定时脚本名称，不是认证身份，不能放凭据。

`submit --human` 仍是异步接纳，不代表执行成功。未给 key 时在发送前生成并向 stderr 输出 source、key 和同实例的只读核对命令；显式 key 原样使用，JSON 不自动补 key。human 写调用最多等待 30 秒，成功回执退出 0，拒绝/普通错误退出 1，已发出但回执未确认退出 2。Ctrl+C 只停止客户端等待，已发出的不确定写仍为 2，不自动 cancel、重发或启动 serve。cancel 回执不是停止证明。

直接调用 socket 时，提交必须包含 `input` 字段。缺少该字段是协议错误，服务返回 HTTP 400 和 `Missing input`，不建立请求或执行。`repo`、`capability`、`source` 必须是非空字符串，否则返回 HTTP 400 和 `Invalid repo`、`Invalid capability` 或 `Invalid source`，不建立记录。格式正确但未登记的 repo 或能力仍按普通提交规则保存拒绝原因。显式 JSON `null` 不是缺失字段，会交给能力校验器，并按普通提交规则保存结果。未知命令返回 HTTP 400 和 `Unknown command`，不会按 `show` 查询记录。

合法提交在同一个 SQLite 事务中保存请求和执行，返回 `accepted: true`、`requestId`、`executionId`。无效 repo、能力或输入在数据库可写时保存拒绝记录，返回 `accepted: false`、`requestId`、`reason`，不建立执行。校验器抛错即拒绝，即使错误消息为空，也不会建立执行。拒绝也是已记录的提交响应，JSON 退出码为 0，脚本必须检查 `accepted`；human 拒绝退出 1。必要保存失败返回非零退出码，不返回接纳或拒绝回执。

`show` 可使用请求或执行标识，包含原始输入、来源、计划时间 `scheduledAt`、去重键 `deduplicationKey`、拒绝原因、执行状态和尝试列表。`list` 只列执行，按提交顺序返回，可按 repo、状态和 `--source` 筛选。没有执行配置的旧能力或未绑定角色保持排队。启动时按当前配置扫描历史 `queued` 主 Agent 请求，已绑定角色参与调度；历史确定性请求保持排队，旧的未知尝试不自动重跑。原请求/执行表保留，旧提交、查询协议和回执字段保持兼容。

提交可选 `--deduplication-key KEY` 和 `--scheduled-at 2026-10-11T00:00:00Z`；socket 字段为 `deduplicationKey`、`scheduledAt`。键必须是非空字符串，计划时间必须是带时区的 ISO 时间字符串，畸形字段返回 HTTP 400，不建立记录。同一 `source` 内，同键且 repo、capability、原始 JSON 输入、计划时间相同，返回原有接纳回执；JSON 对象字段顺序不影响比较，数组顺序有意义，计划时间按原字符串比较。不同内容返回 HTTP 400 和 `Deduplication key conflict`，CLI 非零退出，不覆盖旧记录。不同来源互不合并，无键每次新建。去重只登记成功接纳的请求；拒绝记录保留键线索，但不占键。接纳、执行和键登记在同一 SQLite 事务中完成。

旧 CLI/socket 提交无需更改；旧 SQLite 表与记录保留，启动时只新增元数据和去重旁表，历史记录的两个新字段为 `null`。停服务并备份数据库后升级；不能据此推断任意旧程序都能读新版数据。旧程序若不支持去重，不能在回退期间继续投递需要去重的任务；重新升级也不能为回退期间的请求追补键。换版、兼容范围及回退步骤见[安装说明](deployment-guide.md#资源保留与手工换版)。

外部脚本、cron/systemd timer 配置及补跑边界见 [外部定时提交](readonly-role-tutorial.md#交给-cron-或-systemd-定时提交)。编排器不重建未收到的触发，不阻止排队重叠，请求去重不保证副作用幂等。

不要在输入或配置里写凭据。服务不主动保存环境变量或认证头，但原始输入和校验错误会持久化，输入、配置和运行记录应当作为敏感数据保护。这不是通用秘密过滤器。

# issue-106-task-dependency-feasibility

研究日期：2026-10-18。源码基线：[`a8bd3fcae668c47d2388e3aabce94a7207586a09`](https://github.com/canxer314/sandcastle-orchestrator/tree/a8bd3fcae668c47d2388e3aabce94a7207586a09)。文中的源码链接均固定到这个 commit。

可以实现。最小方案是给现有运行底座补一层持久化任务运行记录，以任务内 Agent 的显式最终结论驱动依赖就绪判断。DAG 判断本身很小，主要成本在结论如何可靠送达、如何关联正确的一次运行，以及重启后如何处理仍在运行或已经产生外部结果的旧执行。现有代码提供了部分基础，但尚未实现这套任务依赖能力，也不能据现有 recovery 宣称无人值守崩溃恢复已经可用。

本次只有源码研究和本地受控验证。已读 `.agents/skills/research/SKILL.md`、`CLAUDE.md`、领域和 issue tracker 约定，并只读核对 #106 及父地图 #105。两个依赖规则已由父线程记录在[用户确认评论](https://github.com/canxer314/sandcastle-orchestrator/issues/106#issuecomment-6236300361)。研究子任务只新增研究文件，没有产品实现、README 修改、Docker 或真实模型试跑。父线程复核后将研究资产发布到独立 research 分支，不合并产品分支。

## 已确认的需求边界

B 依赖 A。A 的任务内 Agent 判断是否已经完成任务约定的交付，随后才放行已被用户选中启动的 B。A 的目标若是提交 PR，按任务要求提交即可能满足；若目标是合并，只有提交 PR 还不满足。进程退出不代表交付完成。A 最终失败只阻塞依赖它的任务及其后代，无依赖的 C 可以继续。任务内自修复、重试以及暂时工具失败都不自动成为任务最终失败。

保留既定产品边界：无人值守；任务内可混合明确步骤与自主委派；任务间只管依赖和顺序；角色可自定义；不强加固定协调角色或人工运行时关卡；只启动用户明确选中的任务。host 准备隔离目录和 repo 访问条件，Agent 读任务后决定 base、branch 和 worktree，host 随后记录真实使用的目录和版本。此处不要求用户预填 base SHA，也不借依赖调度引入通用成果传输系统。相关已发布决策见 [无人值守](https://github.com/canxer314/sandcastle-orchestrator/issues/106#issuecomment-6230096557)、[混合编排与启动范围](https://github.com/canxer314/sandcastle-orchestrator/issues/106#issuecomment-6233136332)、[Agent 选择工作分支](https://github.com/canxer314/sandcastle-orchestrator/issues/106#issuecomment-6235143299)。

## 当前源码能复用什么

1. SQLite 已持久化 `request → execution → attempt`，一次 request 对应一个 execution，重试可以在同一 execution 下增加 attempt。还有启动授权、管理事实与提交去重记录。它没有工作台任务、任务运行、依赖边或任务结论表；公开 `Submission` 类型也没有这些字段。不能把当前 execution 不加区分地当成未来的多角色任务运行。[表结构](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L22-L53)、[Submission 类型](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/config.ts#L168-L175)

2. `control.ts` 已集中扫描持久化队列，检查配置、启动授权和并发配额。启动、submit、retry/resolve 和执行结束会触发调度。可以在这一处加入任务就绪条件，继续沿用 CLI/socket 入口；当前代码没有依赖检查。[dispatch](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/control.ts#L38-L75)、[管理入口及启动扫描](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/control.ts#L93-L168)

3. 单数据目录由 `flock` 限制为一个控制写入者。`beginAttempt` 在事务中插入 attempt、更新 execution 并消费启动授权；`finishAttempt` 在事务中更新 attempt 和 execution。dispatcher 依赖执行入口在首次 `await` 前保存 attempt。这些是防重复领取的可复用基础，事务不包含进程启动或远程写操作。[控制锁](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/lock.ts#L3-L12)、[开始事务](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L254-L271)、[结束事务](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L294-L314)

4. `(source, deduplicationKey)` 已提供提交幂等性，同键不同请求内容会冲突，事务内还会再次检查。已有测试覆盖八个并发提交及重启后返回同一回执。这可以复用到任务启动请求，但目前没有“完成事件去重”协议。[提交去重](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L115-L165)、[相应测试](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/management.test.ts#L689-L704)

5. `mutableAttempt` 只允许改当前 execution 的最新 attempt，并拒绝终态或已有停止确认的 attempt。已有测试证明旧停止回调不能覆盖正在运行的 retry。它解决了部分旧回调覆盖问题，但没有任务级结论回执、事件内容冲突处理或前置运行绑定。[修改保护](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L274-L296)、[迟到回调测试](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/execution.test.ts#L357-L375)

6. role 已能注入 prompt、skills、tools，并保留报告、输出和工具事实。`openRoleTools` 从 host 上下文绑定 execution、attempt、workspace 和 actualSha，适合作为受限结论入口的接缝。但现有 executable role tools 要求 `claude-code` MCP provider，不能据此宣称所有目标 harness 都已支持同一种报告通道。[Role 接口](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/config.ts#L131-L156)、[工具入口与运行检查](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/mcp.ts#L22-L69)、[provider 限制](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/config.ts#L76-L85)

### 必须分开的三种事实

`runState/execution.status = completed` 表示现有运行入口已经收尾。role 的 `validateReport` 抛错时仍写 `completed + contract:error`；确定性 capability 解析失败也如此。[role 收尾](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L186-L201)、[capability 收尾](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/execution.ts#L175-L204)

`contract = valid` 表示配置中的报告解析/校验函数接受了返回值。它的返回类型是 `unknown`，没有统一业务成功语义。受控测试中既有纯文本报告、非零退出码下的合法报告，也有 `completed + exitCode:0 + business.outcome:unknown`。[报告类型](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/config.ts#L131-L140)、[文本及非零退出测试](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/roles.test.ts#L67-L74)、[业务 unknown 测试](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/roles.test.ts#L112-L120)

“任务成功”则是 Agent 对本次任务约定交付的最终判断，并且其结论已经被正确关联和持久接受。这个任务级概念需要新增。不能从 `completed`、`contract:valid`、退出码 0、某个工具成功或 PR URL 非空推导出来。`runAgent` 的退出标记仅提供 CLI 退出事实，SDK 返回本身都不足以证明这一点。[运行适配器](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/agent.ts#L4-L32)

## 建议的最小机制，以下均未实现

### 持久化一次任务启动，而不是只保留页面状态

建议在现有 SQLite 中增量增加任务运行相关记录，保留旧协议和历史数据含义。无需引入另一套工作流服务。至少保存：

- `taskId` 与任务定义版本；目标、交付条件、输入、角色/prompt、步骤或自主委派配置、授权的本次快照。
- `taskRunId` 与本次启动意图键；用户明确选中的任务集合。未选任务可以是依赖引用，但不能因此创建可调度的运行。
- 本次运行的前置绑定 `prerequisiteTaskId → prerequisiteTaskRunId`。尚未启动的前置允许为空，等待后续明确启动；不能每次调度随意查询“最近一个成功结果”。
- 本次运行中的 execution/attempt 映射及当前可报告结论的执行身份。一个任务运行可以包含多角色、多个 execution 和重试 attempt，不强制与现有 execution 一对一。
- 业务结论、结论版本、来源身份、摘要和证据引用；独立保存运行阶段、进程退出、未决副作用、实际代码位置/版本及资源占用事实。
- 已接受报告事件与回执；唯一的启动领取/派发意图，用于重启后重算而不重复生成底层 execution。

任务图先校验同项目有效引用、重复边、自环和有向环。运行使用冻结快照，编辑任务不会悄悄改变已排队运行的依赖和完成标准。

前置绑定需要明确一次运行的语义。建议同批 A、B 优先绑定同批 A 的新 run；只选 B 时，可绑定同版本 A 的当前明确运行，没有则保持未绑定，等 A 后续被明确选中时原子绑定。绑定后冻结，不能因为另一个 A run 后来成功而替换证据。历史结果复用、最终失败后是否给等待中的 B 重新绑定下一次 A，是后续规格需要写清的重跑策略，本轮不把任何一种当作已批准。系统可自动记录绑定，不要求用户填写执行 ID 或 Git SHA。

### Agent 给结论，host 接受并记录结论

建议定义一个窄的任务结论封套，内容包含协议版本、`eventId`、`outcome: succeeded | failed | inconclusive`、任务定义版本、交付摘要、完成依据和证据引用。`failed` 是任务内 Agent 已经结束本次自主修复/重试后的最终结论；中间步骤失败仍留在任务内部记录。`inconclusive` 表示本次没有足够证据作出业务结论，不放行依赖。

可信来源元组至少是 `taskRunId + executionId + attemptId`。由 host 建立的连接上下文绑定它，不能信任 Agent 在 JSON 中任意填写的别人的 ID。任务内既定步骤或委派关系授予最终报告权，普通 reviewer 的局部意见不能直接结束整个任务。这是运行授权，不要求所有任务都增加一个固定“协调者”角色。

最小接入点是一处统一的 `acceptTaskConclusion` 记录函数，加一个任务范围内的报告入口。可沿已有工具 bridge 暴露 `report_task_result`，provider 适配层也可把最终结构化输出送到同一收件函数。二者必须使用同一身份和事件规则，不能各自宣布成功。只解析最终 stdout 是较小的正常路径接入，但不足以覆盖 host 崩溃时的报告丢失。

Agent 根据自己的任务决定“提交 PR”或“合并 PR”是否满足目标，host 只校验封套、来源、权限、版本和必要证据完整性，不在通用 scheduler 里解释自然语言验收标准。通用 host 不应写死 `hasPrUrl ⇒ success`。特定任务可由角色/能力核验 GitHub 状态、测试回执、工作目录和提交，再由 Agent 作最终判断。现有 publication 只实现专用 `orch/*` 分支的 draft PR 发布/查询，并无通用合并能力，不能把它当成所有交付目标都已支持。[publication 实际范围](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/publication.ts#L11-L44)

报告接收的建议事务顺序：

1. 核对可信来源元组和当前最终报告权，核对任务快照版本。
2. 查持久事件键。同键同内容返回原回执，同键不同内容拒绝；不能只在进程内存放一个已处理集合。
3. 如果该 task run 已有最终结论，重复原事件仍返回原回执，新的矛盾终态报告拒绝并保留审计。被替换的旧 attempt/execution 报告不得改变当前 run。
4. 在同一数据库事务内写事件、证据引用和最终结论，提交成功后才回应已接受。证据文件若独立保存，应先可靠落盘再提交引用；缺失、截断或保存失败不能发布成功。
5. 提交后触发调度扫描。通知只用于降低延迟；即使通知丢失，启动时或有限周期的重算也能从数据库恢复就绪状态。

这与现有“仅最新 mutable attempt 可更新”的保护相容，但不能直接复用其静默忽略作为新报告协议。业务结论一旦持久接受便属于该 task run 的事实，CLI 后续退出或 SDK 后处理报错应另记运行事实，不能把已经接受的交付结论悄悄覆盖。反过来，CLI 正常退出而结论缺失，只能记“退出且无结论”。

结论已接收和依赖可放行要分开。任务层还须核对本次配置要求的步骤已经收尾、已知工具及子执行没有未决结果；新报告入口不能绕过当前 `roles.ts` 对未决工具记 unknown 的约束。业务结论可以独立保存，依赖放行要等这些运行条件满足。CLI 的尾部输出或退出处理不必改写已接受的业务结论，但一条成功回报也不能掩盖仍未完成的任务工作。具体 harness 如何确认子执行与工具收尾，仍需真实接入验证。

### DAG 就绪判断只读取已绑定运行的显式成功

建议条件为：`ready(B) = B 已选中启动 ∧ B 尚未领取且未终结 ∧ 所有绑定前置 run 的结论均为 succeeded 且已满足任务收尾条件`。所有前置使用 AND。未绑定、尚在执行、自修复中、无结论或结果不明的前置都不能满足条件。

调度先从数据库计算候选，再在同一领取事务内重新核对选中意图、依赖和资源条件，写入唯一派发意图及底层 execution 关联，然后才调用 runner。把条件只放在页面或内存事件回调里会留下绕过和重启漏洞。对于任务关联 execution，role 与确定性 capability 两条派发路径都要检查；当前 role 路径并不经过相同的 `canStart` 条件。[两条派发路径](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/control.ts#L50-L64)

A 最终失败后，B 及其下游显示 `blocked` 和导致阻塞的前置 run；这是一种依赖阻塞原因，不伪装成 B 自己执行失败。无需给整个批次设置停止开关。独立 C 继续参与正常调度，包括尚未开始的 C。未选中的 A 永不由这个扫描顺便启动。

这里的“不阻塞 C”是依赖语义。现有 dispatcher 把未确认停止的 unknown Agent 计入占用，默认每 repo 限额为 1；A 存活不明时 C 仍可能等资源。需分别展示依赖阻塞和资源等待，不能为了让 C 开始就假定 A 已停止或突破配额。[资源占用计算](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/control.ts#L43-L60)

成熟工作流已有对应的简单规则。Argo DAG 默认 fail-fast，配置 `failFast: false` 可让其他分支继续；GitHub Actions 的 `jobs.needs` 表达所有前置成功后才能运行，并沿依赖链传播失败/跳过。这里借用局部传播和 AND 依赖的机制，不引入它们的平台，也不把容器或 job 成功等同于本产品的业务成功。[Argo DAG](https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/#fail-fast)、[GitHub Actions jobs.needs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)

### 崩溃、迟到报告和重放

当前 Records 打开时把原 `starting/running` attempt 记入 `priorAttempts`，查询时投影为 `unknown`。查询位置明确给出 `processIdentity:null`、`reconnectHandle:null`。它能避免凭旧状态断言仍在运行或已成功，不能重连真实 harness 或重新接收已断开的报告流。[重启处理](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L12-L53)、[查询投影及限制](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/record-queries.ts#L30-L45)

建议按实际持久边界分别恢复：

- 结论已经提交，但 B 尚未领取：重启扫描重新计算，B 可以就绪，不依赖旧内存回调。
- 结论提交后回执丢失：报告方以同一事件 ID 和内容重送，host 返回原回执。report/query receipt 必须能够在重新连接后使用。
- 结论尚未提交，Agent 或 host 中断：需要适配层的持久待发送记录、可重放的最终输出，或恢复同一执行的报告通道。若现有 harness 做不到，保持无结论，不能从日志中一句“完成”补造成功。新进程下的已认证重关联与事件去重是需要开发和验收的能力。
- B 的派发意图已提交，实际进程启动结果不明：用已保存的运行身份、启动键和运行器事实对账。确认未启动才发送，已启动则接回或查询；无法确认则保留 unknown，不能盲目再次启动。
- 旧执行在新 attempt 启动后迟到：隔离令牌或代际检查使旧来源失去最终报告权。旧事件最多作为历史证据，不得完成新 task run。依赖绑定始终引用特定 taskRunId，因此同名任务的历史成功不能串入新运行。
- 外部操作已经发生，但确认结果前断线：由对应工具/适配器查询 PR、提交等外部事实，再由任务内 Agent判断结果。无法取证时收敛为不确定。数据库事件去重不能阻止外部服务执行两次副作用，旧备份还可能同时丢失启动键和结论，必须另做恢复对账。

这些机制允许按配置自动核对、有限重试或以不确定结果结束，不强制增加人工运行时审批。但“无人值守”不能被解释成任意断线后都能证明业务结果。若真实 harness 无法查询、重连或可靠重送，最多先达到自动保守收敛，不能宣称自动恢复后一定继续成功。

现有 `recover` 仍要求停止确认、外部结果核对和审计字段，retry 固定原 SHA 并产生新 attempt；受控测试走人工确认流程。备份恢复演练也依赖独立本地审计、取消旧队列、`restore-review/resume`，明确不宣称 exactly-once。因此这些测试证明已有保守恢复约束，不证明上述新机制已经具备。[recover](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L220-L250)、[恢复测试](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/execution.test.ts#L520-L538)、[备份恢复演练](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/maintenance-restore.test.ts#L171-L206)

## 实现成本主要在哪里

依赖判断成本较低。对本机有限任务集合，扫描冻结 DAG 并算 AND/局部阻塞即可，不需要先建设通用条件表达式、实时跨任务消息或图形编辑器。源码中的集中 dispatcher 和 SQLite 可用来承载这一增量。

任务记录与协议成本中等，需要定义 task/run/execution/attempt 对应关系、启动幂等键、依赖绑定、显式结论、回执与查询状态，还要保持旧 CLI/socket 和数据库可读。现有 `business` 是任意数据，不能迁移时把历史 `completed` 全部回填成成功。没有新结论的历史记录应保留原含义。

可靠报告和无人值守恢复成本最高，尤其是各 harness 的最终输出、报告重送、退出与子任务存活关系、崩溃后的重新认证、执行身份取证和不确定外部写操作。可以保证“未收到可信完整结论就不放行”，但仅靠 prompt 无法保证 Agent 永不漏报、误报或将局部完成当作全任务完成。结构化 schema 只能查格式；模型可能引用错误 PR、误读 merge 状态或忽略最后一步。日志、工具回执和代码版本让事后核对有据可查，不能把自报升级为客观正确性证明。

实际工作目录/版本也是已有需求下必须补的接缝，不能回避。当前 role 在构造 prompt 前要求完整 SHA，生成 `orch/<attempt>` 并初始化 `/implementation`；工具与 revisionSource 固定绑定这个目录。publication 使用该分支和起始 actualSha，revision 导出拒绝嵌套 `.git`。应改为 host 提供隔离 repo 访问，Agent 选择后由受限观察/登记机制记录实际 cwd、base、branch、HEAD/tree，并让测试、导出和交付引用这些实际事实。单纯把字段名改成“Agent 选择”不能解决绑定问题。[启动版本选择](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L22-L36)、[prompt 与初始化](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L90-L123)、[发布绑定](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/mcp.ts#L37-L49)、[revision 限制](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/revision.ts#L7-L34)

因此可以确定技术可行，不能据这次研究承诺精确工期或“加个依赖字段就完工”。首个完整可验收增量应同时包含持久 task run、显式报告、原子就绪领取、重启重算及受控故障验证。跨 harness 的真实报告/恢复验收仍是独立工作，不由这个 DAG 模型替代。

## 本地验证与证据范围

脚本为 [issue-106-task-dependency-probe.mjs](./issue-106-task-dependency-probe.mjs)，输出为 [issue-106-task-dependency-probe-output.txt](./issue-106-task-dependency-probe-output.txt)。在本 worktree 的 Node `v24.21.0` 上运行：

```sh
pnpm exec node research/issue-106-task-dependency-probe.mjs
pnpm exec vitest run tests/agent.test.ts
```

状态脚本 10/10 通过。它覆盖 A→B 与独立 C、未选前置不启动及后续补选、多前置 AND、退出码 0 但无业务结论、失败向后代局部传播、内部重试和旧 execution 迟到、重复事件与冲突终态、结论提交后重开数据库重算、无结论退出后的重开，以及非法 DAG 拒绝。已有 `agent.test.ts` 为 1/1 通过，只检查受控 Sandbox adapter 的 stdin、退出标记和缺失退出证据行为。[该测试源码](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/tests/agent.test.ts#L4-L12)

脚本不导入产品代码，使用一个临时 SQLite JSON 行保存研究状态，报告证据是明确标注的模拟值；脚本的 report 输入假定已通过身份、报告权限和任务收尾条件检查，这些检查本身未被脚本验证。它检查“给定事件如何改变状态”，以及数据库正常关闭重开后结论、绑定和去重记录仍能驱动相同判断。领取次数不是实际进程启动次数。没有真实 kill/power-loss、磁盘故障、多进程竞争、harness 或网络，所以不能拿 10/10 宣称产品 DAG、事务崩溃恢复或真实 harness 完整可用。脚本也不实现任务编辑版本、跨 task run 历史复用策略、资源配额或真实报告鉴权。

父线程另运行了现有 roles / quota 的 7 项相关受控 Adapter 测试，7 项通过、32 项无关测试跳过，验证命令及结果见 [existing tests](./issue-106-existing-tests.json)。这与子任务的 agent 测试合计 8 项现有测试，均不是新增任务依赖的产品验收。

读取了 recovery、management 和 maintenance 的相关测试源码，但本轮没有运行完整套件。`pnpm exec` 首次执行按已有锁文件从本地缓存补齐依赖，未修改锁文件或产品文件。

真实实现的验收还必须覆盖：

- 当前控制服务收到重复启动、重复/矛盾结论、旧 attempt/旧 taskRun 迟到报告时，只有正确运行能获得一次放行；任意角色不能冒充任务最终报告者。
- 在启动意图落库前后、启动响应前后、结论落库前后、回执发送前后强制终止 host，验证重启后的真实查询、重连或保守收敛；磁盘写失败、损坏证据和旧备份恢复不能变成成功。
- 每个实际目标 harness 在长输出、格式不符、上下文压缩、正常/异常退出和仍有子任务时，能否可靠提交或重送结论。不能把 Claude 工具桥的受控通过等同于其他 harness 已通过。
- A 任务目标分别为提交 PR、合并 PR 时，使用已授权环境验证实际外部事实和结论一致；工具调用超时后的重复副作用须单独核对。本轮没有创建、合并或查询实际交付 PR 来做验收。
- Agent 自选目录、base、branch/worktree 后，测试、revision、报告和发布确实指向同一份代码；上游成功不应被当成下游已经取到成果的证明。
- A 自修复期间 B 等待；A 最终失败后 B 及后代阻塞，独立 C 在资源允许时继续。资源耗尽、unknown 活跃进程和任务依赖等待必须能区分。

下一步需要的是上述接缝的规格和受控原型证据。本报告不批准产品实现，也不改变 #106 的待决重跑/历史成果复用规则。

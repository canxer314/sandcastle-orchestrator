# issue-106-idle-followup-feasibility

可以实现，但当前代码不能仅加一个定时器就向同一 Agent 追问。需要补上会话生命周期、运行中输入、任务结论与执行终态的分离；定时检查只负责核对事实和触发合格的补问。

研究基线为 `a8bd3fcae668c47d2388e3aabce94a7207586a09`，日期 2026-10-18。已读 CLAUDE.md、docs/agents/domain.md、issue-tracker.md；子任务审查本仓库及已安装源码/types，父线程补入官方 Harness 能力核验。依赖锁定为 [Sandcastle 0.12.0][lock]；当前 worktree 无 node_modules，依赖证据来自主仓库的既有安装。
新增结果上报工具方向已获用户认可；本轮补问机制是可行性研究，具体接口、阈值和恢复承诺仍未冻结。

下文 `SDK` 指 `/home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/`。固定安装快照的 SHA-256 为 `index.js: 81b59a1de9c5320d307b2812483d0c2f106af5e2511a613b4862ffdccb3c97f5`、`index.d.ts: 39f4ca91da566a7620930ba4811360c697d6b2be1630a540f91f91e9c4095457`。引用标签给出源码行号。

当前代码能证明的事实：

- 每次 `executeRole` 新建 attempt、固定 SHA、`orch/<attempt>` 分支和工作目录，并记录 `sessionPolicy:'new'`；配置只有 buildPrompt/validateReport、provider 和 binding，没有会话控制或追问接口。[roles.ts L22-L33][roles-start]、[L90-L96][roles-prompt]、[config.ts L131-L156][config]
- `runAgent` 给 CLI 命令加随机退出标记，收集 text/result/sessionId；只有标记到达才确认该命令退出。它关闭 SDK completionSignal，并把两种超时设成 Infinity。正常返回只保留输出、iterations、commits；异常只补存已看到的 sessionId，未保留 resume 方法。[agent.ts L5-L31][agent]
- stdout/stderr 实时落盘，stdout 按完整行交给 parser；docker exec 的 close 事件有退出码，但子进程句柄没有对外提供，stdin 一次 `end(opts?.stdin)`。容器本身运行 sleep 循环，容器活着不能证明 Agent 活着。记录明确给出 `processIdentity:null`、`reconnectHandle:null`。[roles.ts L106-L151][roles-io]、[record-queries.ts L30-L38][location]
- `Records.isLive` 只是当前服务内的执行入口集合，beginAttempt 加入、finally/endLive 删除；服务重启后历史 starting/running 投影为 unknown。它不是原生进程存活或 idle 探针。[records.ts L14-L17、L53、L254-L277][records]、[roles.ts L208][roles-end]、[record-queries.ts L30-L38][location]
- SDK 的 ParsedStreamEvent 只有 text/result/tool_call/session_id/usage；公开回调只有 text/toolCall/raw，没有通用 turn 结束、成对 tool 开始/结束、子执行状态。raw 也只是收到的 stdout 行，不能补造缺失事件。[SDK index.d.ts L60-L76、L244-L272][sdk-types]
- SDK parser 会丢信息：Claude 仅筛出部分 tool_use 且不保留调用 ID；Codex 把 agent_message 当 result，把 turn.completed 降成 usage；Pi 只筛部分 tool_execution_start，把 agent_end 的末条文本当 result，也把错误当 result。故 result 不等于可靠 turn 结束或任务结论。[SDK index.js L2789-L2844][sdk-claude-parser]、[L3096-L3213][sdk-pi-codex-parser]
- SDK 的 idle 计时按 stdout 行重置，告警表示“多久没收到行”，不是模型停工；当前封装还禁用了失败超时。进程活着、没有 stdout、出现 result，单独都不能证明可追问。[SDK index.js L195-L235、L258-L305][sdk-invoke]、[agent.ts L28][agent]
- host 自有 MCP 执行工具记录 callId、starting 和后续结果，内部维护 active/unknown；`unresolved()` 合并两者，尚非可订阅的细分状态。只读工具用 handlers 集合等待关闭，仅在结果阶段落 observations，没有对外暴露 pending。原生外部 MCP 只注入配置与能力描述，不经 host 工具代理；不能声称掌握全部工具或子 Agent 的开始/结束。[mcp.ts L28-L93][mcp]、[role-tools.ts L18-L76][read-tools]、[native-mcp.ts L8-L42][native-mcp]
- 角色退出后保存报告，等待只读工具关闭；自有 MCP 活跃或 unknown、缺退出证据、持久化失败会留下 unknown。随后 validateReport 决定 contract，甚至 contract:error 也可对应 runState:completed。此处没有“提交最终任务结论”工具，attempt completed 不能直接成为规划中后续任务的放行信号。[roles.ts L165-L208][roles-end]、[config.ts L139-L156][config]

会话捕获与恢复的实际边界：

- 安装版本的 Claude、Codex、Pi provider 都默认 captureSessions:true 并实现 sessionStorage，分别生成 `--resume`、`exec resume`、`--session` 命令。部分 types 注释仍称仅 Claude 支持，按实现判断这份安装，不据此宣称目标 CLI 官方验收通过。[SDK index.js L3148-L3162、L3215-L3239][sdk-providers]、[L3415-L3433][sdk-claude]、[index.d.ts L139、L294-L299][sdk-types]
- capture 在 invokeAgent 成功返回之后执行，要有 sessionId、storage 和 handle；非零退出在 invoke 内抛错，不会走该捕获步骤。成功时 iterations 可带 sessionFilePath；只有 sessionId 不保证历史已保存。捕获或后处理失败后，本项目 catch 返回的 sessionId 也不能作为恢复许可证。[SDK index.js L289-L305、L454-L497][sdk-capture]、[agent.ts L29-L31][agent]
- storage 导出 JSONL 并改写 cwd，resume 先检查主机历史，再回拷进 sandbox。Claude 子 Agent transcript 捕获是尽力而为，恢复函数只回拷主会话；Pi 的 hostSessionFilePath 实际返回目录。会话文件不是完整执行、工具结果或工作目录快照，恢复须逐项核实。[SDK index.js L16-L44][sdk-precheck]、[L2953-L3093][sdk-storage]
- `SandboxRunResult.resume(nextPrompt)` 实际再次调用 sandbox.run，再经 exec 启动 CLI；复用 sandbox/历史不等于向旧活进程 send。方法仅按 storage+sessionId 挂载，调用时仍需文件检查。本项目丢弃该方法、不传 resumeSession，且 `copyFileIn` 直接抛错，现有恢复路径接不通。[SDK index.js L1573-L1597、L1723-L1747][sdk-resume]、[L382-L395][sdk-restore]、[L2915-L2924][sdk-file-in]、[roles.ts L145-L156][roles-io]、[agent.ts L28-L31][agent]
- SDK 另有 interactive/interactiveExec 的 stdio 接口，但不是结构化 turn/steer 协议；本项目 handle 没实现 interactiveExec。当前既不支持活会话追加新 turn，也不支持忙时 steer；不能把调整 stdin.end 或切 interactive 当成已经解决生命周期问题。[SDK index.d.ts L841-L863][sdk-sandbox]、[SandboxProvider types L13-L50][sdk-handle]、[SDK index.js L1749-L1760][sdk-resume]、[roles.ts L125-L151][roles-io]

建议的最小接口边界，以下均为设计建议，尚未实施：

1. 在 `agent.ts` 与 `roles.ts` 之间增加会话驱动边界，提供生命周期事件、当前状态核对、`sendTurn`、恢复与停止能力声明；忙时 `steer` 单列为可选能力。事件保留原生 ID、来源、时间、执行代次、turnId、toolCallId，区分进程存活、turn 结束、工具/子执行待办和连接未知。不选择新依赖。
2. 生命周期事件驱动判断，`control.ts` 的单写者负责串行登记补问意图；定期检查只补偿遗漏和重核状态，不能从日志静默推断 idle。现有 dispatch 只处理 queued 执行，尚无这个检查器。[control.ts L38-L73][control]
3. “沉默”只记最后输出时间；“忙”有未结束 turn；“工具等待”有未结束调用或远程任务；“idle”须由原生生命周期事实确认且相关工具、子执行已收尾；支持同步 Stop hook 的 Harness 也可在准备结束的安全检查点直接提醒补报，不必等 CLI 退出；“退出”须有对应执行的退出证据；缺失、断连或事件覆盖不全归 unknown。只有确认 idle、没有最终结论且没有待办，才向该会话补问。忙/挂起工具不盲目插 prompt；未知不并行双启。
4. 已退出只在旧执行确定停止、待办工具/子执行已核对、会话历史与 Agent 选定的工作目录完整保存时 resume。保存 provider/nativeSessionId、cwd、工作区引用及上一执行关系；不凭 sessionId 重建原始 SHA 工作区。本项目现在由 host 固定分支/worktree，这与规划中 Agent 自选不同，续接接口应接收实际工作区事实。[roles.ts L32-L33、L117-L123][roles-start]
5. 同一活进程中的追问是同一 attempt 下的新 turn；进程重启恢复则登记新 attempt，并关联逻辑任务、Agent 会话、previousAttemptId、触发 turn 和追问原因。旧 attempt 终态保持原样，任务结论另存。现有 mutableAttempt 冻结终态，beginAttempt 要求 queued；需显式 continuation 入口，不能把旧 attempt 改回 running。[records.ts L254-L310][records-continuation]
6. 不能直接调用现有 recover(retry)：它要求停机及外部结果核对、清掉 cancellation 并重新 queued，角色随后按新会话重新构建原任务。补问应带既有结果与副作用回执，只询问状态、缺失结论和必要收尾；不默认重跑实现、提交或发布。副作用结果未知先查询核对，不能把“没完成工具调用”当失败重试理由。[records.ts L220-L247][recover]、[roles.ts L32、L90-L96][roles-start]
7. 新最终结论工具可接在现有 per-attempt MCP 授权边界，host 绑定任务/会话/attempt/turn 身份，校验结构、权限和结论回执去重，Agent 决定业务结论。工具接受结论后仍等待约定收尾事实，再放行后续；不能用 stdout、SDK result、旧 attempt.contract 或退出码代替结论。迟到的旧代次报告不重新结束任务，也不归到新 turn。[mcp.ts L22-L24、L54-L70][mcp]、[records.ts L274-L310][records-continuation]
8. 补问意图、发送回执和消费状态持久化；按任务/会话代次/触发 turn 去重，同会话仅一个待发送追问。发出但回执丢失时先查证，不能自动重发。补问前再次核对终态与待办，取消/停止、已确认最终结论优先；设冷却、次数上限、任务总预算和恢复预算，数值留待预算决策。达到限制进入可观测的停止/阻塞状态，不能自动宣告业务完成。
9. 上述机制用于任务内任何获授权的角色会话，不强制协调角色，不要求人工实时回答。阻塞或 unknown 可以无人值守地保留和告警；现有人工 recover 不是自主恢复策略。停止沿用先记录意图的原则，现有 Agent cancel 仅写合作停止文件并记 unknown，不能当作已退出。[execution.ts L52-L65][cancel]

实施前应验证的场景：

- 长时间推理无 stdout、只有 stderr、半行缓冲；长工具/子 Agent/远程任务等待；这些都不得误发追问。事件覆盖不足保持 unknown。
- 确认 turn 结束却漏结论时恰好补问一次；工具结果迟到、最终结论与定时检查竞态、重复/乱序事件、旧 turn 报告均不重复放行。
- CLI 已退出但 stdout 被后代持有；退出标记缺失；容器仍 alive；服务重启失去句柄。未核实旧执行停止时不得另起同会话。
- 捕获关闭、无 sessionId、捕获/持久化失败、Pi 目录被误当文件、Claude 子会话缺失、cwd 或 Agent worktree 被清理；恢复失败不得退化成重跑原任务。
- 发送成功但回执丢失、补问期间取消/预算耗尽、最终工具被重复调用，以及曾有发布等副作用结果未知；核对后恢复，不重复副作用。
- 后续需用目标 harness 验证真实 turn/tool/子执行事件、空闲新 turn、忙时能力与退出后恢复。本文没有运行模型、Docker、模拟状态机或全套测试，也不声称官方目标 harness 已全验收；官方能力核验见下节，不能替代真实接入验收。

## 官方 Harness 能力补充，2026-10-18 核对

Claude Code：同步 `Stop` hook 可以检查本次执行是否已有结果回报，并返回继续指令；当前文档还列出后台任务和计划唤醒信息，应据此区分空闲与等待。用户中断、API 失败走不同路径，不能一概继续。它是“准备结束但漏报”的直接接法，不必先改成通用双向输入；配置挂载、结果查询入口、停止/预算和去重仍需接入。需要任意时刻后续输入时，CLI stream-json / SDK Streaming Input 支持持久会话；退出后 resume 要保留会话文件与工作目录。官方：[Stop hook](https://code.claude.com/docs/en/hooks#stop)、[流式输入](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)、[会话恢复](https://code.claude.com/docs/en/agent-sdk/sessions)。

Codex：App Server 的 `thread/read` 和 `thread/status/changed` 可观察 idle/active 等状态，`turn/completed` 是一轮结束，仍不等于整个任务成功。空闲时用 `turn/start` 在同一 thread 发后续输入；忙时的 `turn/steer` 要匹配 `expectedTurnId`，不能代替空闲续问。保存的会话可 `thread/resume` 后继续。官方 Goals 示例也在 turn 结束、无待处理工作/输入、thread idle 时才自动继续；若使用原生继续，应和宿主补问共用或协调触发权，避免双重唤醒。官方：[App Server](https://learn.chatgpt.com/docs/app-server)、[Goals 的继续条件](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。

Pi：本次官方源码固定提交为 `c268154ca1171c2f9eefe75d3d7372a68aada2d5`。RPC 提供 `get_state`、`prompt`、`steer`、`follow_up`。`agent_end` 后仍可能自动重试、压缩或消费后续队列；当前文档给出 `agent_settled` 作为本会话本轮自动工作结束的边界。仅 `isStreaming=false` 不能判闲，`get_state` 也没有覆盖所有自动恢复中间状态。已保存的会话可重新加载，`--no-session` 不提供这种恢复基础。官方：[运行生命周期](https://github.com/earendil-works/pi/blob/c268154ca1171c2f9eefe75d3d7372a68aada2d5/packages/coding-agent/docs/rpc.md#run-lifecycle)、[RPC 命令](https://github.com/earendil-works/pi/blob/c268154ca1171c2f9eefe75d3d7372a68aada2d5/packages/coding-agent/docs/rpc-commands.md)。`agent_settled` 也不证明其他独立 Agent 或未登记外部进程都停止。

以上是官方能力核查，未调用真实模型/容器或执行真实会话实验。当前推荐 Claude 镜像固定 2.1.296，不能把滚动文档中的新字段直接当作该镜像保证；Codex/Pi 也需锁定目标版本/schema 并验证。低频轮询调用状态接口本身不要求推理，只有真正补发 prompt 才会产生新的模型调用；尚未测量本项目的开销。

父线程建议：完成上报工具为主；利用原生结束/空闲事件及时检查，定期查询补漏。检测到安静只先检查状态；确认本轮已结束、无已知待办、未收有效结论且未停止/超预算后才允许同会话补问。检查事件、Stop hook、定时巡查与原生自动继续要协调为单一有效触发，不叠加多个循环。收到 prompt 的传输回执不等于 Agent 已理解或已经补报，回执丢失也不能盲重发。

建议补问文本：本次任务尚未收到最终结果。请核对现状：如已完成，调用结果工具提交结论和依据；如仍有工作，在原授权与预算内继续；如无法完成，提交失败或无法确定的结论并说明原因。不要重复已经完成的外部操作。

[lock]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/pnpm-lock.yaml#L112-L114
[agent]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/agent.ts#L5-L31
[roles-start]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L22-L123
[roles-prompt]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L90-L96
[roles-io]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L106-L156
[roles-end]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L165-L208
[config]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/config.ts#L131-L156
[records]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L14-L277
[records-continuation]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L254-L310
[recover]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/records.ts#L220-L247
[location]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/record-queries.ts#L30-L38
[mcp]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/mcp.ts#L22-L93
[read-tools]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/role-tools.ts#L18-L76
[native-mcp]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/native-mcp.ts#L8-L42
[control]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/control.ts#L38-L73
[cancel]: https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/execution.ts#L52-L65
[sdk-types]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.d.ts:60
[sdk-invoke]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:195
[sdk-claude-parser]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:2789
[sdk-pi-codex-parser]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:3096
[sdk-providers]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:3148
[sdk-claude]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:3415
[sdk-capture]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:454
[sdk-precheck]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:16
[sdk-storage]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:2953
[sdk-resume]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:1573
[sdk-restore]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:382
[sdk-file-in]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.js:2915
[sdk-sandbox]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/index.d.ts:841
[sdk-handle]: /home/canxer/repos/sandcastle-orchestrator/node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/dist/SandboxProvider-EkSMuBp8.d.ts:13

# Issue #29 联合验收记录

## 范围与结论

2026-10-12，在应用基线 `a88f56282c897d6133b8430cf808d5704d8b11ec` 完成两个临时 repo 的真实指定 commit 测试、Issue 实现到 Draft PR，以及同一只读分析角色跨 repo 复用。本轮只新增验收记录，没有修改产品功能、协议或持久化格式。已检查 README，不需要修改公共行为说明或 changeset。

真实样例通过不代表 #29 所有场景都重新做过真实演练。配额、未知结果、故障、清理、通知及维护恢复复用现有受控测试；已有 MCP 服务的真实接入复用 #23 历史记录。本文分别记录这些证据。首次全套回归有一项超时，后续复验通过，但原始输出没有完整启动 argv，不能确认其串行参数，也不能作为串行证明。根因未确定，独立记录于 [#49](https://github.com/canxer314/sandcastle-orchestrator/issues/49)。没有关闭 #29，也没有发布产品分支。

## 授权与环境

用户明确授权使用 `/tmp/issue-21-repos-ES4yky/{alpha,beta}` 及 `/tmp/issue-21-repos-wMJ16g/{alpha,beta}`，不限模型、provider、费用和调用次数，允许真实容器与专用 GitHub fixture 写入。实际验收使用第一组；第二组仅由主会话只读检查状态、remote 和 SHA，没有修改。两组最初都没有 remote，工作区干净。

创建两个私有 fixture repo，分别是 `canxer314/issue-29-acceptance-a6e3` 和 `canxer314/issue-29-beta-a6e3`，仅上传获准 fixture 内容，没有上传产品源码或凭据。每个 fixture 创建 Issue #1，业务目标为新增 `ACCEPTANCE.md`，说明 fixture 身份、非产品范围和可复现只读检查，保持 README 原字节不变。不关闭 Issue、不合并或部署。

- alpha 固定 SHA 为 `8f6d4b185dadf233e5ec4047d7ba922fd3a63fb8`。
- beta 固定 SHA 为 `899b751eda555051f0e0cbe9fc4335667b7fc31d`。
- Node `24.21.0`，pnpm `12.3.4`，Sandcastle `0.12.0`，Docker `29.8.1`，gh `2.46.0`。
- Docker 镜像 `issue-19-acceptance:2.1.296`，ID `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。
- provider 配置为 `claudeCode('opus', {effort:'low'})`，实际 assistant 日志模型为 `gpt-6.1-sol`。这是已有 Claude CLI → CC-Switch 路由验收，不证明 Anthropic Opus 直连、其他 provider 或上游计费。
- 配置与证据位于 `/tmp/issue-29-acceptance-a6e3/`，实现数据位于 `/tmp/issue-29-data-a6e3/`。使用独立私有目录，不提交原始 session、认证环境或完整敏感日志。

首次隔离 worktree 子 Agent 的配置生成命令被 guard 在执行前拒绝。实际 cwd 正确，但 Node 输入含 Git credential-helper 文本，guard 无法确认操作范围。该次未启动应用或模型，专用 relay 已停止。用户随后明确授权改由当前主环境执行验收；没有修改全局安全设置。主环境配置和控制服务正常启动。

## 真实指定 commit 测试

两次测试均经公开 `submit/show/logs` CLI/socket，真实无网络 Docker 执行同一 `test-commit` 能力。运行结束、contract valid、exit 0、`business.passed:true` 分别保存，不用正常退出替代业务判定。actual SHA 与请求 SHA 一致，workspace 独立。

| Repo | Execution | Attempt | 配置版本 |
| --- | --- | --- | --- |
| alpha | `c0d95047-dffa-45f5-8fb6-f1cb6e341b45` | `29917c68-a7c7-488a-9c72-77d32552aeb3` | `issue-29-real-a88f562-v1` |
| beta | `a2d12931-4e7c-4e23-8d87-f62fbbb1126d` | `8f0385f4-24ee-41f1-8feb-208bd539de7e` | `issue-29-real-a88f562-v1` |

两次能力运行约一秒。定向检查验证原 fixture README 身份；若存在 ACCEPTANCE.md，再检查其身份、范围及命令说明。文档存在是可选条件，因此该能力本身不能证明实现已交付，后续另做业务检查。公开日志输出 `PASS: unchanged fixture identity and optional acceptance scope/documented read-only check`。

## 真实 Issue 到 Draft PR

普通配置复用 `examples/implementation.ts`，业务调查、修改、测试和发布时机由模型自主决定，没有写进 scheduler。两个 repo 复用同一角色、工具及 provider。模型只写本次独立 implementation clone，发布由 host writer 限定目标 repo、base master 和 `orch/ATTEMPT` 分支。

| Repo | Execution / Attempt | 耗时 | 配置版本 |
| --- | --- | --- | --- |
| alpha | `e977648c-789b-4a48-a60d-5da54fe3abc3` / `a7bfeec7-8c52-4754-9162-21aec29aeb25` | 88.411 秒 | `issue-29-real-a88f562-v1` |
| beta | `951ff24e-df02-4348-ba5f-d28ca3249dc4` / `a60b0c62-8776-49a4-a46e-c95e0ee9352f` | 518.653 秒 | `issue-29-real-a88f562-v2` |

两者实际调用内部 `run_tests` callId `1`，导出 dirty revision 的隔离树后测试，再调用 `publish_draft`。内部 MCP 没有建立新的顶层请求或 attempt。两者自然结束，completed、contract valid、exit 0，并保存实际退出 marker。beta 曾数分钟没有新增日志，但 Claude 与 MCP bridge 存活；没有取消、强杀或盲目重试，它随后自然完成。

- alpha [Draft PR #2](https://github.com/canxer314/issue-29-acceptance-a6e3/pull/2)，commit `67c37956bfcf73e32529195ba95a4b3f96bb1942`，测试及远端树 `48360d96f8d22cf379ce4571cd496f7e516de419`。
- beta [Draft PR #2](https://github.com/canxer314/issue-29-beta-a6e3/pull/2)，commit `11b95500662bfef01bce24353551c3897a2f89d6`，测试及远端树 `0e60ea72236e0bd7471cf48beb762e4266d9419c`。

独立 GitHub 查询和 diff 核对两份 PR 只新增 ACCEPTANCE.md。独立执行文档中的原始只读 Node 命令，验证 README 与各自基线字节相同。PR 正文引用 fixture Issue、基线及测试证据，明确不代表产品验收或 Issue 解决。所有 PR 已登记到线程。

## 真实 PR 分析及跨 repo 复用

管理员另外创建 alpha fixture [Draft PR #3](https://github.com/canxer314/issue-29-acceptance-a6e3/pull/3) 作为对照材料，不冒充模型实现产物。管理员通过 GitHub 收集 alpha PR #2/#3 的 metadata 和 diff，快照采集时间 `2026-10-12T03:27:21.747Z`，内容摘要 `eeec2e9998ff5dd58138fe29437a8b186eac1e96b14eccfb1d7440289c6963b1`。缺少 inline review threads、checks 及 Issue 讨论，均显式标记。

原 `createPrSnapshotTool` 契约返回 `verifiedAgainstGitHub:false`，这是管理员提供的历史快照，不是工具独立验证的实时 GitHub 事实。工具实测拒绝授权范围外 PR #1。

为不重启仍运行的 beta 实现任务，分析使用独立控制服务和数据目录。它是另一个单控制服务部署，不验证两个服务合计配额。相同 `createPrAnalysisRole` 及 alpha #2/#3 scope 分别绑定 alpha/beta 两个不同固定 checkout，beta checkout 不冒充 alpha PR head。

| Repo | Execution | Attempt | 耗时 |
| --- | --- | --- | --- |
| alpha | `8a32691c-6f99-478c-8640-537b1aca2785` | `b012a19c-e981-4038-9823-01b22df9fc1c` | 85.462 秒 |
| beta | `a0ccaddc-8bd1-4bfb-acbf-27587f0f0f0c` | `5ea8c5f3-733c-4794-947b-09a2f91b93ac` | 99.297 秒 |

配置版本均为 `issue-29-real-a88f562-analysis-v1`。两份报告自然 completed、valid、exit 0，模型均自主调用 PR #2/#3 快照工具。公开 `artifact` 分别读取 `observations.jsonl` 和 `report.txt`，保留事实与推断的区分。独立判断报告引用了快照版本、digest、缺失项和不同 SHA，区分 PR #2 的报告测试与 PR #3 缺少测试回执，不捏造跨 PR 共性产品 bug。模型最初读取不存在路径获得真实错误后，改用已部署 MCP 工具。

### 后续最小补验收，beta 分析自己的 PR

上述 beta 历史分析发生在其实现 PR 创建之前，分析对象仍是 alpha PR #2/#3，只证明角色跨 checkout 复用，不满足 beta 自己的测试、实现、分析时间顺序。历史报告及快照不改写为新证据。

补验收启动时，子 Agent 最初仍受 worktree 环境限制，立即报告且没有执行任何工具。运行时随后将主目录更新为 `/home/canxer/repos/sandcastle-orchestrator`；第一次 `pwd` 与 Git 状态检查成功后才继续。主 Agent 确认无人并发执行 beta 分析或 fixture 写入，并独占完成本次补验收。没有修改权限设置或绕过拒绝。

beta 原模型实现只有 [Draft PR #2](https://github.com/canxer314/issue-29-beta-a6e3/pull/2)，创建于 `2026-10-12T03:33:32Z`。管理员随后创建文档对照 [Draft PR #3](https://github.com/canxer314/issue-29-beta-a6e3/pull/3)，创建及更新时间 `2026-10-12T04:09:28Z`，head `0613dfd20c0d34c67d08ccd9fd61024bf425dbcb`。对照仅新增 REVIEW-NOTES.md，正文及文件明确非模型实现、未提供测试回执，不冒充第二次实现或产品验收；创建后立即登记线程。

管理员实际采集 beta #2/#3 metadata、reviews 和完整 diff，快照版本 `issue-29-beta-github-export-v2`，采集时间 `2026-10-12T04:09:46.164Z`，SHA-256 `d3675027af71ec74c9d14d993490a28a06cde65a65287fd1f4db0ecba3293347`。两份均 `truncated:false`，reviews 为空；inline review threads、checks and CI logs、Issue discussion 均缺失。工具仍明确 `verifiedAgainstGitHub:false`，管理员导出不等于工具实时独立验证。

新私有配置及证据为 `/tmp/issue-29-supplement-a6e3/`，DATA/session 为独立的 `/tmp/issue-29-supplement-data-a6e3/`，配置版本 `issue-29-real-a88f562-beta-analysis-v2`。复用现有 role、tool、provider、internal Docker 网络及镜像；只登记 beta，只读且移除 publication，scope 仅 beta #2/#3。第一次 serve 因 DATA 放在配置目录下被产品边界检查拒绝，尚未提交请求或调用模型；改为独立 DATA 后启动成功。这是验收配置错误，不是产品修复。

只经公开 CLI `serve/submit/show/logs/artifact` 提交一次新 beta 分析，没有重试或补模型调用。请求 `99f1c28b-0edd-4440-b4db-546fdad85c4b`，execution `744e5f04-bcf7-4a23-ace6-cbce1e376acd`，attempt `934e3f61-6650-42a8-8d62-a40984ef1a6a`。请求接纳于 `2026-10-12T04:10:43.361Z`，尝试开始 `04:10:43.377Z`，自然结束 `04:12:17.797Z`，94.420 秒。请求、selected SHA、actual SHA 均为 beta 基线 `899b751eda555051f0e0cbe9fc4335667b7fc31d`，workspaceMode readonly，completed、contract valid、exit 0，真实 agent-exit-marker 保存；正常结束不代替业务判断。

公开 observations 记录模型在 `04:11:02.547Z` 与 `04:11:06.134Z` 自主分别读取 beta #2 和 #3。公开 report.txt 为 7,256 字节，完整且未截断。`2026-10-12T04:13:46.695Z` 独立核对两份工具观察、摘要与报告，确认报告区分 PR #2 的测试叙述与其未提供原始回执、PR #3 的管理员对照及无测试回执，也明确双方缺少 review threads、CI logs、Issue discussion。报告只交付有根据的证据共性，没有编造共性产品 bug，没有把 checkout 基线冒充两个 PR head，没有把未见失败当成所有测试通过。其判断只适用于所采集的小型文档 fixture，不是通用代码质量证明。beta 自己的指定 commit 测试、模型实现 PR #2、分析 beta #2/#3 至此按时间顺序完成；alpha 既有同序证据保留。

## 容器与访问边界

真实测试容器 network none，`/workspace` 只读，只有 `/artifacts` 可写，没有模型或 GitHub 认证环境。模型容器使用 internal 网络 `10.231.19.0/28`，只经本次 gateway relay 到已有 loopback provider。真实连接 `1.1.1.1:443` 返回 ENETUNREACH；这是一项边界探针，不证明所有网络路径均已审计。

实际源目录 touch 失败，宿主 GitHub config 和 Docker socket 不存在。模型不挂载宿主 home 或 writer 认证目录；implementation clone 是独立可写目录，源 workspace 和 Git metadata 只读。只读分析不配置 publication，工具 scope 固定，不具有发布入口。host writer 使用管理员已有 gh 认证及 proxy，仅向获准 fixture 的专用分支普通 push，不把凭据传给模型或测试。

## 受控回归与历史证据

本轮读了 #29、父 #14、tracker/domain 指引；八个前置 #17/#21/#23/#24/#25/#26/#27/#28 均 CLOSED。状态不是行为证据，对应源码和测试也已核对。

| 联合核对范围 | 本轮复用测试 |
| --- | --- |
| 全局/repo 主 Agent 配额、跳过满额 repo、准备占额、未知保留额度、确定性工作不占额 | `tests/quota.test.ts` 的 oldest eligible、concurrent submissions、restart retains unknown |
| 必要保存失败、控制服务异常退出、停止未确认、人工核对后重试 | `tests/execution.test.ts` 的 required save failure、operations drill、unknown attempt |
| 显式期限、协作停止、报告与退出分离、跨 repo 角色 | `tests/roles.test.ts` 的 report/end 参数化场景及同角色跨 repo |
| 内部 MCP、不新增顶层任务、发布未知与查询 | `tests/mcp.test.ts` 的 stdio execution semantics，含 implementation、push-lost、pr-lost |
| 外部定时提交、source、可选去重与不补跑 | `tests/external-submission.test.ts` 及 `tests/management.test.ts` |
| 日志/产物读取、模型推断和观察分离 | `tests/pr-analysis.test.ts` 及本轮真实公开 CLI artifact |
| 到期清理、保留未决证据、通知错误处理 | `tests/cleanup.test.ts` 及 management notification bridge |
| 实际 SQLite/tar 备份恢复、旧快照暂停人工核对、维护升级 | `tests/maintenance-restore.test.ts`、quota restore 测试及 `docs/issue-27-local-acceptance.md` |

这些故障测试使用受控 provider/执行适配器。SQLite/tar 恢复确实操作本地数据，但不代表真实运行模型的崩溃恢复演练。已有 MCP 服务的真实原契约接入与其他历史验证见 `docs/issue-23-real-acceptance.md` 等记录，本轮没有重新跑真实已有 MCP 服务。

主环境 typecheck 通过。相关回归首批 7 files 为 122 passed、20 skipped、61.41 秒；management/agent/role-tools/roles 四文件为 86 passed、70.36 秒。首次全套为 211 passed、20 skipped、1 failed、76.65 秒。唯一失败在 `maintenance-restore.test.ts:98`，初始 saved 执行等待 completed 超时，实际仍 running；第 99 行 pause 尚未执行，所以失败发生在 pause、backup、restore 之前，不能据此判定维护恢复功能失效。当时有并行测试负载，但未证明根因。未改源码、断言或 timeout，后续维护单文件 3 passed、7.70 秒，完整复验 12 files、212 passed、20 skipped、73.21 秒。两份原始复验输出仅显示 `$ vitest run tests/maintenance-restore.test.ts` 与 `$ vitest run`，未保存完整启动 argv，不能确认 `--no-file-parallelism` 生效；原先“串行复验”的说法撤回。复验通过不是修复证明。[独立记录 #49](https://github.com/canxer314/sandcastle-orchestrator/issues/49) 关联 #27/#29，仅保留事实，根因未知，本轮不开展诊断或产品修复。20 个 opt-in Docker 测试未启用，不计为通过。本轮真实容器场景单独记录，不用默认 suite 替代。

### 后续维护回归补验收

2026-10-12，[PR #51](https://github.com/canxer314/sandcastle-orchestrator/pull/51) 在另行授权的本地诊断与测试修复范围内补强维护等待；测试提交为 `327c255df4d68ac56e679f1b46b4d94647b0fb61`，基线为 `c168eccf826532fab08f48cb4b9890e3af135084`。Node `24.21.0`、pnpm `12.3.4`、Vitest `5.0.3`。本次只修改维护测试与两份既有验收记录，不新增产品行为，不改协议、持久化或全局 timeout。它不替代 #29 的真实联合验收，不修改先前运行的事实或其 argv 限制。

- [x] 受控完成延迟超过默认 poll 期限时先 red；显式局部 10000ms 等待后 green；加载时回退为一秒再次 red。
- [x] 启动前延迟 1200ms 时，默认一秒检查在 pause 前因 `started-live` 尚未出现而 red；显式启动预算后 green；加载时回退再次 red。仍等待真实适配器启动。
- [x] 经真实服务/socket 确认 `start_failed` 后开始计时，旧等待耗约 10005ms，五秒检查 red；终态短路后 green；加载时恢复旧逻辑后再次 red。五秒检查不含服务冷启动或准备，不是产品性能承诺；`unknown` 仍继续等待真实退出确认。
- [x] 原维护暂停、协作取消、独立审计、旧快照恢复与跨版本升级断言保留；失败证据读取缓存 detail 和本地日志，16 个第二轮失败目录已确认保留。最终只读审查未发现正确性缺陷，仅一项可选等价简化，未应用。

最终测试版本的验证如下。相关回归结束后才启动完整套件，未并行叠加多轮全套；每份本地输出保存完整命令和 exit code。

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过，exit 0 |
| `ORCHESTRATOR_REAL_DOCKER=0 pnpm exec vitest run tests/maintenance-restore.test.ts --no-file-parallelism` | 1 file，5 passed，11.84 秒，exit 0 |
| `ORCHESTRATOR_REAL_DOCKER=0 pnpm exec vitest run tests/maintenance-restore.test.ts tests/management.test.ts tests/quota.test.ts tests/roles.test.ts --no-file-parallelism` | 4 files，101 passed，141.13 秒，exit 0 |
| `ORCHESTRATOR_REAL_DOCKER=0 pnpm exec vitest run --no-file-parallelism` | 12 files，214 passed / 20 skipped，270.01 秒，exit 0 |
| `git diff --check` | 通过 |

20 个 opt-in Docker 测试仍 skipped，不计通过；本轮没有调用真实模型、容器或业务远端写入。较早一次审查全套曾在 `tests/pr-analysis.test.ts:97` 失败，为 212 passed / 1 failed / 20 skipped，未确认与维护测试 diff 有因果关系，未借本票修改该测试；最终通过不抹除这次失败。

原始日志、配置和 session 不上传。私有本地证据为 `/tmp/issue-49-tdd-NitBih/` 与 `/tmp/issue-49-review-tdd-6gw4J6/`，临时留存不保证长期归档。受控诊断复现了一秒等待先于自然完成的竞态，但 [#49](https://github.com/canxer314/sandcastle-orchestrator/issues/49) 原事故的 DATA 和细分时序缺失，不能把新复现追溯为历史事故已证明修复，因此 #49 保持打开。#27/#29 已有验收项及关闭状态不变，只补充本轮受控回归证据。

合并前补充文档后再次 typecheck 通过。首次相关四文件复验为 100 passed / 1 failed，122.45 秒，exit 1；唯一失败在未修改的 `tests/quota.test.ts:100`，SQLite/tar 恢复用例的初始 saved 等待 received running / expected completed，发生在 pause 和备份之前。本轮完整套件因此未启动。保留原输出，不归因为本 PR，也不借本 PR 扩大 timeout 或修改额度测试。随后原样单跑该用例为 1 passed / 12 名称过滤 skipped，1.99 秒，exit 0，不把单跑成功当成根因已确定。未改代码、测试参数或 timeout，再次依次执行同样的相关回归和完整套件：相关四文件 101 passed，123.23 秒，exit 0；完整套件 12 files、214 passed / 20 skipped，265.20 秒，exit 0。补文档后的 typecheck 和 `git diff --check` 也通过。合并前复验输出在 `/tmp/pr-51-delivery-UryWzC/`，原始失败输出同目录保留，后续通过不证明该 quota 失败已定位或修复。

## 收尾

补验收主 Agent 另行执行 `pnpm run typecheck`，通过；显式 `pnpm exec vitest run tests/management.test.ts tests/roles.test.ts --no-file-parallelism` 为 2 files、83 passed、107.70 秒、exit 0。本轮显式 `pnpm exec vitest run --no-file-parallelism` 第一次因执行工具后台 120 秒上限而终止，不是测试断言失败，也不计通过；原输出 `/tmp/issue-29-supplement-full-regression.txt` 保留。未改源码或测试 timeout，以 600 秒工具时限执行同一全套命令，结果 12 files、212 passed、20 skipped、278.45 秒、exit 0，输出 `/tmp/issue-29-supplement-full-regression-retry.txt`。这是新一轮有明确 argv 的串行证据，不追溯证明旧复验参数。类型及 management/roles 输出由主会话保留，相关回归文件 `/tmp/claude-1000/-home-canxer-repos-sandcastle-orchestrator/ebde5ec5-eab3-4c10-85b2-3c69cc50d1a1/tasks/bitjs4xqq.output`。20 skipped 不计通过，本次真实分析仍单独记录。

所有本次模型和工具自然结束后，对 implementation service、analysis service 和本次 relay 的精确 PID 发 SIGTERM。进程消失，两管理 socket 查询 ENOENT，relay 连接 ECONNREFUSED，原 CC-Switch loopback 服务仍监听。核对结果见 `shutdown-check.txt`。后台退出通知属于计划收尾，不是实测异常崩溃。

四个原模型容器保留 idle shell/sleep，无 Claude/MCP 进程；已结束测试容器也保留。补验收新增容器 `orch-934e3f61-6650-42a8-8d62-a40984ef1a6a-1` 自然结束后只剩 shell/sleep。仅对本次 service PID `750547` 和 relay PID `736819` 发 SIGTERM；`2026-10-12T04:13:58.854Z` 核对 PID 均消失、control.sock ENOENT、relay ECONNREFUSED，原 provider 的 loopback `127.0.0.1:15721` 仍监听。证据为补验收目录 `container-processes.txt`、`shutdown-check.txt`，未动旧部署或 provider。没有删除容器、远端 fixture 或证据，没有强杀模型制造通过。这不证明所有潜在子进程和远端工作已停止。

## 原始证据与限制

私有证据目录保存 `alpha/beta-test-{receipt,show,logs}.json`、`alpha/beta-implementation-{receipt,show,logs,artifact}.json`、internal test 日志、remote tree/diff、独立文档命令输出、容器边界探针，以及 `alpha/beta-analysis-{show,logs,report.txt,observations.jsonl}` 的 CLI JSON 回执。快照为 `pr-snapshot.json`，回归文件为 `typecheck-main.txt`、`relevant-tests-main.txt`、`socket-role-tests-main.txt`、`full-tests-main.txt`、`maintenance-retest-main.txt` 和 `full-retest-main.txt`。临时目录不是长期归档保证。

操作中曾误用 management.sock，得到 ENOENT；改用服务实际公布的 control.sock 后才接纳任务。beta fixture 初始人工 push 缺 credential helper 失败，随后用命令局部 helper 成功，没有修改全局 Git 配置。这些是验收操作错误，不记为产品缺陷。

本次规模为两个小型文档 fixture，两个实现调用和三个分析调用；其中原 beta 分析只分析 alpha 材料，新 beta 分析才覆盖 beta 自身 PR 且在实现后发生。补验收原始 CLI 回执、快照、metadata/diff、独立检查与收尾证据在 `/tmp/issue-29-supplement-a6e3/`，DATA/session 在 `/tmp/issue-29-supplement-data-a6e3/`，均为私有临时目录，不承诺长期归档。线程最终 PR 登记核对有四份 open Draft PR，alpha #2/#3 与 beta #2/#3，全部已 link。不能推断一般代码实现质量、高可用、全机资源保障、所有 provider、全部子进程停止或端到端 exactly-once。真实运行中控制服务崩溃、真实未知远端副作用、旧备份回退和所有故障组合没有重做；只能引用相应受控或历史证据。首次回归超时保留为未确定根因的发现，不能声称已修复。需要继续真实已有 MCP 或更大业务样例时，应另行记录实际证据，不扩大本票产品实现范围。

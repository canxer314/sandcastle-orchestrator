# Issue #29 联合验收记录

## 范围与结论

2026-10-12，在应用基线 `a88f56282c897d6133b8430cf808d5704d8b11ec` 完成两个临时 repo 的真实指定 commit 测试、Issue 实现到 Draft PR，以及同一只读分析角色跨 repo 复用。本轮只新增验收记录，没有修改产品功能、协议或持久化格式。已检查 README，不需要修改公共行为说明或 changeset。

真实样例通过不代表 #29 所有场景都重新做过真实演练。配额、未知结果、故障、清理、通知及维护恢复复用现有受控测试；已有 MCP 服务的真实接入复用 #23 历史记录。本文分别记录这些证据。首次全套回归有一项超时，串行复验通过，根因未确定。没有关闭 #29，也没有发布产品分支。

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

主环境 typecheck 通过。相关回归首批 7 files 为 122 passed、20 skipped、61.41 秒；management/agent/role-tools/roles 四文件为 86 passed、70.36 秒。首次全套为 211 passed、20 skipped、1 failed、76.65 秒，`maintenance-restore.test.ts` 等待 completed 超时，实际仍 running；当时有并行测试负载，但未证明根因。串行维护单测 3 passed、7.70 秒；串行全套 12 files、212 passed、20 skipped、73.21 秒。20 个 opt-in Docker 测试未启用，不计为通过。本轮真实容器场景单独记录，不用默认 suite 替代。

## 收尾

所有本次模型和工具自然结束后，对 implementation service、analysis service 和本次 relay 的精确 PID 发 SIGTERM。进程消失，两管理 socket 查询 ENOENT，relay 连接 ECONNREFUSED，原 CC-Switch loopback 服务仍监听。核对结果见 `shutdown-check.txt`。后台退出通知属于计划收尾，不是实测异常崩溃。

四个模型容器保留 idle shell/sleep，无 Claude/MCP 进程；已结束测试容器也保留。没有删除容器、远端 fixture 或证据，没有强杀模型制造通过。这不证明所有潜在子进程和远端工作已停止。

## 原始证据与限制

私有证据目录保存 `alpha/beta-test-{receipt,show,logs}.json`、`alpha/beta-implementation-{receipt,show,logs,artifact}.json`、internal test 日志、remote tree/diff、独立文档命令输出、容器边界探针，以及 `alpha/beta-analysis-{show,logs,report.txt,observations.jsonl}` 的 CLI JSON 回执。快照为 `pr-snapshot.json`，回归文件为 `typecheck-main.txt`、`relevant-tests-main.txt`、`socket-role-tests-main.txt`、`full-tests-main.txt`、`maintenance-retest-main.txt` 和 `full-retest-main.txt`。临时目录不是长期归档保证。

操作中曾误用 management.sock，得到 ENOENT；改用服务实际公布的 control.sock 后才接纳任务。beta fixture 初始人工 push 缺 credential helper 失败，随后用命令局部 helper 成功，没有修改全局 Git 配置。这些是验收操作错误，不记为产品缺陷。

本次规模为两个小型文档 fixture，两个实现调用和两个分析调用。不能推断一般代码实现质量、高可用、全机资源保障、所有 provider、全部子进程停止或端到端 exactly-once。真实运行中控制服务崩溃、真实未知远端副作用、旧备份回退和所有故障组合没有重做；只能引用相应受控或历史证据。首次回归超时保留为未确定根因的发现，不能声称已修复。需要继续真实已有 MCP 或更大业务样例时，应另行记录实际证据，不扩大本票产品实现范围。

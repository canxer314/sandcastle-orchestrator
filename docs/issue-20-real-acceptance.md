# Issue #20：真实协作停止验收

验收日期为 2026-10-11。真实正常路径的应用代码固定为 `1f5bbcc55e1b4a0102ff7e536a0ef124824e4594`，没有混入主工作区 #23 的修改。本记录只证明以下真实运行，不代替 #20 的全部故障与竞争测试。结束证据保存失败的修复在 `35e6219`，其与合并后到期清理的交互均由受控 CLI/socket regression 覆盖；本次真实运行没有验证这些场景。

## 授权和环境

用户明确授权当前主机的专用测试容器、非敏感临时 repo、沿用 #19 的 CC-Switch 路由和真实模型费用。没有 GitHub 写入、生产凭据访问、OAuth 文件复制、CC-Switch 配置修改或 host network。

- Sandcastle `0.12.0`，Effect `3.20.0`，Claude Code CLI `2.1.296`。
- 使用 #19 已有镜像 `issue-19-acceptance:2.1.296`，镜像 ID 为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。
- 内部网络 `issue-19-acceptance`，网段 `10.231.19.0/28`。本次 relay 只监听 `10.231.19.1:15721`，仅接受该网段容器，转发到已有 `127.0.0.1:15721` CC-Switch。
- 临时 repo `/tmp/issue-20-acceptance/repo`，固定 SHA `1e8f3d40cd67ccb9d0b6902aff0b2bfff06bd28d`。只有写明 project name 为 `lighthouse` 的无敏感 `context.txt`。
- 独立配置 `/tmp/issue-20-acceptance/config.mjs`，独立数据 `/tmp/issue-20-acceptance-data/`。配置在内存读取已有代理认证和模型映射，凭据值不写入配置或本文。不得发布完整 Docker environment、原始 session 或未经筛选的 inspect。
- provider 仍为 #19 的 `claudeCode('opus', {effort:'low'})` 经 CC-Switch/Codex OAuth。CLI init 声明 `claude-opus-4-8[1M]`，实际 assistant 事件声明 `gpt-6.1-sol`。这不是 Anthropic 直连验收，不能把 CLI 模型标签或其费用估算当成上游实际计费证明。

先读取 #14、#20、项目 tracker/domain 指令和 #19 实测记录，再检查入口、SDK adapter、持久记录和既有设施。`claude-api`、`run` skills 已加载。通过 `pnpm start serve` 启动公开控制服务，所有提交、取消、查询和日志读取都使用公开 CLI/socket。

角色提示模型读取 fixture，在有限只读观察期间自主选择检查点读取 `/orchestrator-stop/requested`，看到停止信息后整理报告并正常结束。观察间隔使用前台 `sleep 15`，没有每步强制轮询、后台工作或子 Agent。

## 运行中用户取消

主要运行的 execution 为 `9dec16a0-dacb-4fa2-8cde-105421e09ce9`，attempt 为 `ab58712c-32c2-418a-b193-e878e4789339`，session 为 `59d249f1-c569-4342-8833-765a64d32307`。

- attempt 于 `06:11:59.550Z` 建立，默认没有 `attemptDeadlineSeconds` 或 `deadlineAt`。
- 原始事件证明模型于 `06:12:03.831Z` 调用 Read 读取 fixture，随后 Read stop 文件得到不存在，于 `06:12:12.260Z` 开始前台 `sleep 15`。
- 公开 `cancel` 于 `06:12:23.230Z` 持久化 `Authorized user cancellation during fixture inspection`。取消响应先有持久化意图；后续 `show` 为 `runState: unknown`、`cancellationNotification: published`，没有 `stopConfirmation`。发布不是结束。
- sleep 正常完成后，模型再次调用 Read，工具结果包含当前 attemptId、executionId、reason 和 requestedAt。模型整理 `lighthouse` 报告，此后没有新的 sleep 或检查工具调用。
- 原始退出标记为 `ORCH_EXIT_3e2b47ce74214278f68173b61fd18458ddbc400af81f7bab:0`。最终 `show` 为 `cancelled`、`exitCode: 0`、`logs.complete: true`，`stopConfirmation.kind` 为 `agent-exit-marker`，时间 `06:12:34.699Z`。
- SDK 成功导出 session JSONL，文件可读，145277 字节。`docker top` 仅剩容器待机 `sh` 与 `sleep 3600`，没有活动 Claude CLI。

试图检查未结束时拒绝 replacement 的一次 CLI `retry` 请求遗漏 `--external-results`，返回 `Missing externalResults`。它只证明参数校验，不证明实际 replacement gate；没有产生替代 attempt。不把这个操作算作真实禁止替代验收。

## 显式期限

execution 为 `36874958-2640-462b-8f66-1f42f73323f7`，attempt 为 `177ea393-d9fe-4c33-9b9b-e870703784df`，session 为 `532cfcb0-8f93-47a3-9c55-e0255075e516`。

- binding 显式配置 45 秒。attempt `createdAt` 为 `06:10:53.609Z`，`deadlineAt` 为 `06:11:38.609Z`，正好相差 45 秒。截止时间在 repo/sandbox/CLI 准备前确定，不从第一次模型工具调用起算。
- 模型读取 fixture 并执行两次前台 `sleep 15`。第一个检查点 stop 文件尚不存在；期限在第二次 sleep 期间到达。
- 控制服务于 `06:11:38.611Z` 持久化 `kind: deadline` 和原因 `Explicit attempt deadline reached`，距预定期限 2 ms。待退出阶段仍为 `unknown`，没有确认结束。
- 下一个检查点 Read 得到本 attempt 专属停止信息。模型报告精确 attemptId、reason、requestedAt 和 project name，停止新的检查工作并正常结束。
- 原始退出标记为 `ORCH_EXIT_ee0fd35bae6b9f36d3393e69dbcf4c5f9a230e3796d61ce8:0`。最终 `cancelled`、`exitCode: 0`、`logs.complete: true`，可信结束时间 `06:11:57.104Z`。期限到实际结束约 18.5 秒，真实结果直接体现协作停止并非立即强制超时。
- session JSONL 可读，152264 字节；结束后 `docker top` 仅剩待机 shell/sleep。

## 首次 relay 中断

环境检查时内部地址已有 `/tmp/issue-22-acceptance/relay.cjs` 的监听，策略与 #19 相同。首次 execution `9a14bdf2-52b3-4f7f-993d-ffdef4525613`、attempt `130da3f6-d62c-42bf-8e91-6acb7a4aa438` 启动后，该已有 relay 退出。容器探针得到 `ECONNREFUSED`，CLI 原始事件出现 provider `api_retry`。没有停止或修改他人的 relay。

本次在确认内部地址已无监听后启动自己的同策略 `/tmp/issue-20-acceptance/relay.cjs`。首次 attempt 于 provider 重试期间收到公开取消，文件可从容器读取，但当时没有可信结束，未当成成功。relay 恢复后模型实际 Read fixture 和 stop 文件，自主整理报告退出。

该 attempt 的取消时间为 `06:10:43.238Z`，可信退出时间为 `06:11:39.068Z`，原始标记 `ORCH_EXIT_b39cebb5a5efa8a45554ba8fcafd6c4d887a06857711dfdf:0`。session `ca6d9415-1625-4c69-aeef-71236e53f461` 可读，145751 字节。它证明 provider 暂不可达不等于取消立即生效；主要运行中工具取消证据来自上一节的独立成功运行。

## 隔离、持久化和清理

三次容器经筛选的 inspect 均显示 UID/GID `1000:1000`、readonly rootfs、workspace/Git metadata/stop 目录 `RW: false`。不同 attempt 使用不同 stop 目录，容器 Read 的身份与各自记录一致，用户取消原因与 deadline 原因没有串用。临时 fixture repo 不变。

三次原始退出标记、SDK session 导出和无活动 CLI 的 `docker top` 核对完成后，重启自己的控制服务。三个公开 `show` 响应与重启前逐字节相同，没有自动重跑。之后才停止本次三个已退出的待机容器、自己的 relay 和控制服务。`docker stop` 结束不响应 TERM 的待机 shell 后，容器状态为 `Exited (137)`；该码属于事后设施清理，不是 Agent 退出码，也没有用它确认 Agent 已结束。保留容器、数据库、日志、session、临时 repo 和配置供复核，没有删除共享网络/镜像或他人资源，没有改动 CC-Switch 监听及登录状态。

本机原始证据位于 `/tmp/issue-20-acceptance/`，持久数据和 session 位于 `/tmp/issue-20-acceptance-data/`。临时目录不是长期归档保证；本文保存脱敏事实，原始 session 不提交。

## 测试和未验证项

- 本 SHA 的 `pnpm run typecheck` 通过。
- 完整 `pnpm test` 为 5 files passed、78 passed、20 skipped。相关 CLI/management、roles、agent 测试包含在完整运行中。20 个 Docker opt-in 测试未启用，不能计作通过。
- 本次真实运行没有发现需要实现修复的新问题。relay 中断是环境事件，CLI `retry` 参数遗漏是验收操作缺口。
- 排队取消、发送失败、不配合、终态竞争、结束保存失败和准备阶段期限到达等故障场景依靠 controlled-adapter 测试，本次没有逐一注入真实 provider 故障。45 秒实测证明计时点包含正常准备，不证明任意长准备或确定性通用超时。
- 没有验证子 Agent、内部工具、远端任务停止或写入回滚；模型没有创建此类任务，不能以本次主 CLI 退出推断它们的行为。
- 协调者另有审查发现涉及 deadline 持久化失败后丢弃后来真实退出证据。该修复不在本次 `1f5bbcc` 中，本次没有注入持久化失败，不能用正常路径实测宣称修复已验收。

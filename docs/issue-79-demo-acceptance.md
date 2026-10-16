# Issue #79 实施与验证

基线为 `origin/master` 的 `c13c2b0`，独立 worktree 分支 `issue-79-demo-lifecycle`。前置 #76、#78 已分别经 PR #91、#93 合并。实现只消费已合并代码，未使用其他票的未合并分支。

新增 `demo`、`init --reset-demo`，保留既有 serve ready JSON、管理命令、执行状态机和人工 unknown 恢复机制。demo 使用子进程句柄和带 runId 的 IPC ready 通知确认本次服务，再用真实 Unix socket 只读查询确认可用。遗留记录检查在启动前和服务持有 control 锁后各做一次；reset 持有 demo/control 锁，重建前重查路径和记录。

每次提交前保存稳定 source/key 的 journal。回执丢失只读核对，unknown 保留保护；执行记录、attempt stdout/stderr 和独立服务日志均保留。业务结果、执行停止、服务退出分别输出。预算固定为启动 30 秒、执行 5 分钟、收尾 30 秒。

## 受控证据

`tests/demo.test.ts` 通过真实 CLI、配置加载、控制服务、Unix socket、SQLite 和 Git，使用 PATH 中的受控 Docker adapter。故障 preload 只作用于 HTTP 回执、IPC ready 和时钟，不替换提交、执行或记录逻辑。

覆盖当前完整 SHA 和新 commit、dirty tree 保留、成功/测试失败/契约故障、历史和日志保留、已有服务与遗留排队任务、ready 与只读查询双门槛、固定预算、两次 Ctrl+C、回执丢失与无匹配、不确定重跑保护、reset 确认/路径冲突/历史保留，以及参数提前拒绝和 JSON 流隔离。测试先复现未提供 demo 与 reset 未生效，再实现对应行为。

`pnpm run typecheck` 通过。专项 demo/打包测试 31 项通过，之后补充服务持锁复查竞态；现有 queries/writes/management 测试 144 项通过。最终全套 `pnpm test` 为 21 files passed / 2 skipped，399 passed / 22 skipped。真实 Docker/连接/setup 验收开关显式关闭。首轮全套暴露测试侧 1 秒就绪等待过短，增加测试等待后全套通过，生产预算未变。

## 验收边界

未运行真实 Docker、真实模型、私人连接或真实任务，也未拉取镜像。受控 adapter 的成功不能作为真实 Docker 验收通过。未发布包、push 分支、创建 PR 或修改远端 issue。

手工解除 unresolved journal 需要独立核对受理、结果、停止及原服务退出，并保留审计说明，不能仅删除 journal 或把取消回执当停止证明。详见 [demo 指南](demo.md)。

## 审查修正

Standards 初审发现 1 项明确问题和 2 项判断性建议。reset 历史保留测试已从数据库字节比较改为 CLI `list/logs --offline` 前后对比。保留少量直接结果字段赋值，避免为三个字段引入额外状态抽象；故障时钟仍观察 CLI 公布的阶段提示，文案变化时需同步测试触发条件。

Spec 初审发现 3 项问题，均补充失败复现与修正：拒绝拥有其他 worktree 的演示主仓库；将可信 validate/commit 回调的诊断转向 stderr；执行等待已超时时保留回执核对消耗后的同一收尾预算，不重新分配 30 秒。

另补人工工具核对的兼容回归。demo 遗留任务检查复用记录模块既有的 toolNeedsReview/toolReconciled 判定，允许已经通过 confirm-stop/resolve 完成审计的历史。相关判定只移到只读模块供双方复用，未改状态机或审计条件。此前这类历史仍被保守拒绝，CLI/socket 回归已复现并修正。

审查修正后再次运行完整门禁：`pnpm run typecheck` 通过，`pnpm test` 为 21 files passed / 2 skipped，399 passed / 22 skipped。demo 专项现有 21 个测试。

最终两路复审：Standards 无明确违规，数据库侧通道测试问题已修复；少量局部字段赋值符合仓库的简单实现规则，不再要求抽象。仅保留 1 项非阻塞维护建议，CLI 阶段文案变化时同步故障时钟触发条件。Spec 无剩余发现，确认三项原问题已修复，人工工具核对判定条件未改变，无额外范围扩张。复审是静态审查，没有新增真实执行验收。

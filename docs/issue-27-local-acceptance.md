# Issue #27 本地主机备份恢复验收

本次通过公开 CLI/socket 验证维护行为，使用真实 `sqlite3 .backup`、`PRAGMA integrity_check` 和 `tar` 备份、恢复 SQLite、配置、日志及产物。执行适配器和 provider 是受控替身，没有调用模型、运行真实容器或访问远端服务。

主机 UTC 实测时间为 `2026-10-11T16:11:34.368Z`，备份开始点为 `2026-10-11T16:11:31.894Z`。从复制 SQLite、解包配置及证据到核对完成并 resume 共 645 ms。时间来自演练主机，不代表生产恢复期限。

## 复跑

```sh
pnpm exec vitest run tests/maintenance-restore.test.ts --disableConsoleIntercept --reporter=verbose
```

需要主机已有 Git、SQLite CLI 和 tar。本次使用 Node `24.21.0`、pnpm `12.3.4`、SQLite CLI `3.46.1`、GNU tar `1.35`。测试使用独立临时目录，结束后清理。备份频率配置为手动按需、每次受控升级前，没有部署 timer。生产频率、保留期、异机复制和告警仍由管理员配置。

## 备份之后的实际写入

先完成 `saved` 任务，暂停启动并提交 `stale`，再暂停接纳和启动，等待控制服务退出后离线备份。备份包含 `saved` 的记录、日志和 `report.txt`，以及尚无 attempt 的 `stale` 队列。

原数据恢复服务后明确 resume，使 `stale` 实际完成；再提交并完成 `missing`。受控适配器在备份范围以外的独立主机目录写入两份实际产物和审计行，包含 execution ID、时间和产物名称。这些写入不会随 SQLite 恢复消失。

从旧备份恢复至新的数据及配置目录，以 `--maintenance restore` 启动。公开入口验证配置可加载、`saved` 的记录、日志和报告可读，`stale` 仍 queued 且无 attempt，`missing` 不在 show/list 中，未核对前 resume 被拒绝。操作者读取独立审计和两份实际产物，找回快照缺失的执行及已发生写入，取消 `stale`，将执行 ID 和核对结果保存到 restore-review，再明确 resume。

最后提交并完成 `fresh`，作为调度确实恢复的正向检查。独立审计只增加 `fresh`，`stale` 没有新 attempt，旧写入未重复。这仅验证本次人工核对流程，不是通用 exactly-once 保证。

## 不能等待已有执行

另一用例在受控 Agent 已 running 后暂停维护。暂停不终止它。通过公开 cancel 发布协作停止请求后，记录仍 unknown，没有 stopConfirmation，也没有把请求发出当作实际结束。受控适配器正常返回可信 exit marker 后才记录 cancelled 和停止确认，维护仍暂停。没有主动关闭 harness 或容器制造结束。

## 回归结果

最终 `pnpm run typecheck` 通过。管理、额度与本次恢复演练的三个文件共 72 个测试通过。`pnpm exec vitest run --no-file-parallelism` 完整回归为 12 files passed、206 passed、20 skipped，20 项是未启用的 opt-in Docker 测试。

首次并行全套有三个 cleanup 用例超过默认 5 秒时限；单独复跑 cleanup 与演练的 48 个测试全部通过，最终串行全套也通过。没有修改测试时限或将 skipped 计为通过。

## 人工介入和限制

人工介入包括暂停、判断已有执行是否可信结束、离线备份、检查完整性、恢复配置及证据、查阅备份外审计、取消陈旧队列、记录核对和明确恢复。无法确认执行或外部写入时保持暂停，不自动 retry。

测试没有部署生产备份任务，也没有验证真实模型、真实容器、第三方写入、异机恢复、磁盘损坏、大数据恢复或时钟偏差。磁盘损坏最多恢复到可用备份点，演练耗时不能作为生产 RTO 或零丢失承诺。可执行的升级、权限及恢复步骤见 README 的维护章节。

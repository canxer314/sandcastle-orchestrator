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

## 跨应用版本升级实测

新增用例先运行旧应用生成 completed 记录、完整日志和 `report.txt`，停止旧控制服务并离线备份，再在原 DATA 和原配置上运行新应用 `serve --maintenance paused`。没有先恢复到另一个 DATA，也没有用同版本恢复替代升级。

应用按 Git commit 标识，两边 package version 都是 `0.1.0`，不能用它区分版本：

- 旧应用固定为 `806ff4c74af8073d85efea2e0e7bfc61ecd07f8a`，尚无 maintenance。
- 新应用实测为 `baf3d906a02e54b9496f6e49b4f5b51bc2ecb6df`，使用当前工作树的生产代码；本次只新增测试和验收记录。
- 配置版本保持 `maintenance-local-v1`。本次实际配置 SHA-256 为 `b1f872b60b624667680a8747ccdb8c6176a3c4f6eb56eb1ea5fdff752363e22c`，升级前后字节完全一致。配置包含临时路径，复跑 hash 会变化。

旧应用从本地 `git archive` 解包至新临时目录，仅 symlink 已有 `node_modules`，没有安装依赖或联网。复跑要求本地 Git 对象库包含上述旧 commit；浅克隆或不含 Git 历史的源码包无法运行此跨版本用例。它复用现有演练 fixture 的本地 Git 仓库和受控 provider/Docker。旧版没有 pause 命令，人工步骤先等待公开 show 确认 completed，再停止唯一控制 writer；不存在用 SIGTERM 冒充活动 Agent 已停止的步骤。

主机 UTC 实测完成时间 `2026-10-12T01:38:31.373Z`，离线备份点 `2026-10-12T01:38:30.298Z`，备份完成 `2026-10-12T01:38:30.330Z`。真实 `sqlite3 .backup` 及 `PRAGMA integrity_check` 返回 `ok`，tar 保存原 DATA 的日志及产物和配置。频率仍为手动按需、受控升级前执行一次，没有生产 timer。新应用启动到读取核对并明确 resume 共 586 ms，不包含前置备份和之后新任务执行，不作为生产 RTO。

公开入口读取结果：

- 旧执行 `0ac71656-7172-4af1-a3a0-d19838a792ae` 在 list 中存在，show 与升级前完整结果相同，仍 completed，attempt 配置版本仍为 `maintenance-local-v1`。
- logs 与旧应用读出的结果完全相同，available、complete，stdout 包含 `"key":"old"`。
- artifact 读取 `report.txt` 与升级前相同，解码内容为 `{"summary":"done","key":"old"}`。
- maintenance 显示接纳和启动均暂停，公开 submit 返回 `Admission is paused`。人工确认旧配置、记录、日志和报告后明确 operator resume，两个暂停标志变为 false。
- 沿用原配置提交的新执行 `1ff5b1f4-f722-4ee0-834d-db63a05d9188` completed，配置版本未变。独立本地主机审计仅有 `old`、`upgraded` 两次写入，旧记录仍未变化。

### Red / green 与复跑

先把新增用例中升级目标暂设为旧应用 `oldApp`，运行下面的单用例命令。旧执行、证据读取和离线备份均已完成，升级启动失败，错误为 `Unknown option '--maintenance'`，exit 1。这证明旧目标不能满足暂停启动要求，不是夹具准备失败。然后仅把升级目标改为当前应用，保留旧数据生成端。

```sh
pnpm exec vitest run tests/maintenance-restore.test.ts -t 'upgrade from' --disableConsoleIntercept --reporter=verbose
pnpm run typecheck
pnpm exec vitest run tests/maintenance-restore.test.ts tests/management.test.ts tests/quota.test.ts --disableConsoleIntercept --reporter=verbose --no-file-parallelism
```

首次当前目标运行还发现测试误把未设置的 `restorePending` 当成显式 false；该字段实际省略。删除这项与升级暂停要求无关的断言后，三个相关文件 73/73 passed，其中跨版本用例通过并输出上述真实证据。没有修改生产代码、数据格式、配置接口、旧命令或 rollback 机制，不需要行为 changeset。README 已链接本文并说明暂停升级和匹配旧备份回退，无需重复增加链接。

本次补验收的 `pnpm run typecheck` 通过，三个相关文件 73/73 passed，Spec 独立复跑维护演练 3/3 passed。完整串行回归尚未通过：首次为 209 passed、3 failed、20 skipped，`pr-analysis.test.ts` 两项 20 秒超时、一项 EPIPE；该文件单独复跑 20/20 passed 后，未改代码或时限再次完整运行，结果为 198 passed、14 failed、20 skipped，失败分布在 pr-analysis、management 和 quota。保留这些失败，不用相关文件成功替代完整回归成功；完整回归失败原因尚未确认，不能宣称本次具备合并条件。

本次没有执行备份回退或证明旧程序能读新表。匹配旧备份恢复和外部副作用核对仍是回退前提。真实模型、容器、远端写入、异机灾备和生产部署未验证；没有新增自动迁移或恢复平台。

## 人工介入和限制

人工介入包括暂停、判断已有执行是否可信结束、离线备份、检查完整性、恢复配置及证据、查阅备份外审计、取消陈旧队列、记录核对和明确恢复。无法确认执行或外部写入时保持暂停，不自动 retry。

测试没有部署生产备份任务，也没有验证真实模型、真实容器、第三方写入、异机恢复、磁盘损坏、大数据恢复或时钟偏差。磁盘损坏最多恢复到可用备份点，演练耗时不能作为生产 RTO 或零丢失承诺。可执行的升级、权限及恢复步骤见 README 的维护章节。

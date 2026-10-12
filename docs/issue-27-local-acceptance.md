# Issue #27 本地主机备份恢复验收

本次通过公开 CLI/socket 验证维护行为，使用真实 `sqlite3 .backup`、`PRAGMA integrity_check` 和 `tar` 备份、恢复 SQLite、配置、日志及产物。执行适配器和 provider 是受控替身，没有调用模型、运行真实容器或访问远端服务。

主机 UTC 实测时间为 `2026-10-11T16:11:34.368Z`，备份开始点为 `2026-10-11T16:11:31.894Z`。从复制 SQLite、解包配置及证据到核对完成并 resume 共 645 ms。时间来自演练主机，不代表生产恢复期限。

## 复跑

```sh
pnpm exec vitest run tests/maintenance-restore.test.ts --disableConsoleIntercept --reporter=verbose
```

需要主机已有 Git、SQLite CLI 和 tar。本次使用 Node `24.21.0`、pnpm `12.3.4`、SQLite CLI `3.46.1`、GNU tar `1.35`。测试使用独立临时目录，成功后清理，失败时保留证据目录并输出路径。备份频率配置为手动按需、每次受控升级前，没有部署 timer。生产频率、保留期、异机复制和告警仍由管理员配置。

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

修复前补验收的 `pnpm run typecheck` 通过，三个相关文件 73/73 passed，Spec 独立复跑维护演练 3/3 passed。修复前两轮完整串行回归均未通过：首次为 209 passed、3 failed、20 skipped，`pr-analysis.test.ts` 两项 20 秒超时、一项 EPIPE；该文件单独复跑 20/20 passed 后，未改代码或时限再次完整运行，结果为 198 passed、14 failed、20 skipped，失败分布在 cleanup、management 和 quota。保留这些失败，不用相关文件成功替代完整回归成功；后续诊断及修复后结果见下。

### CLI 超时诊断

将失败缩为既有公开 CLI 用例，未修改断言或 5 秒时限：

```sh
taskset -c 0 pnpm exec vitest run tests/cleanup.test.ts -t CLI.cancellation --maxWorkers=1 --reporter=verbose
```

固定同一 CPU 后，`c783cc0` 连续 3 次均超时（5155/5143/5115 ms），基线 `baf3d90` 同样连续 3 次超时（5133/5082/5190 ms）。该超时不依赖新增升级用例。逐段计时显示每次 CLI 启动约 660–710 ms，多次请求累计耗尽预算；客户端沿 `control → roles → provider/MCP` 静态导入了仅服务端需要的运行时。

将配置及执行运行时的导入移至 `serve()`，保留公开命令、socket 协议和记录格式。相同用例连续 3 次通过（1853/1771/1827 ms）。原 cleanup 组合从 2 failed、33 passed、81.90 秒变为 35 passed、69 个名称过滤跳过、44.95 秒。这定位并修复了可复现的 CLI 启动成本问题，不据此断言已经解释历史 EPIPE 或 quota 超时。

修复后类型检查通过；cleanup、management、maintenance-restore 三个完整文件 106/106 passed；独立静态审查 Standards 和 Spec/compatibility 均无发现。主工作树运行 `ORCHESTRATOR_REAL_DOCKER=0 pnpm exec vitest run --no-file-parallelism`，结果为 **12 files passed、212 passed、20 skipped、exit 0**，耗时 266.37 秒。20 项仍是未启用的 opt-in Docker 测试，不计作通过。历史 EPIPE 和 quota 超时在这轮未复现，但尚无独立根因结论。临时计时探针已删除，未修改测试断言或 timeout。

本次没有执行备份回退或证明旧程序能读新表。匹配旧备份恢复和外部副作用核对仍是回退前提。真实模型、容器、远端写入、异机灾备和生产部署未验证；没有新增自动迁移或恢复平台。

## 维护等待回归补验收

2026-10-12，另行授权的本地诊断与测试修复交付于 [PR #51](https://github.com/canxer314/sandcastle-orchestrator/pull/51)，测试提交为 `327c255df4d68ac56e679f1b46b4d94647b0fb61`。本次只补强维护测试和验收记录，不改产品源码、CLI/socket 协议、持久化格式、完成或停止确认语义，也不重开 #27。

对应既有验收项核对如下：

- [x] 旧快照恢复、独立写入审计、取消陈旧队列、人工核对后恢复及跨版本暂停升级断言全部保留，完整维护文件 5/5 passed。
- [x] 受控适配器正常启动和完成各延迟 1200ms，先以默认一秒 poll 产生 red，再以局部 10000ms 生命周期预算产生 green。启动仍以真实 `started-live` 文件为检查点，不用提前记录的 execution running 代替。
- [x] 已确认的 `start_failed` 不再等满十秒；不匹配终态立即失败，目标状态仍精确断言。原协作取消用例继续验证 `unknown → cancelled`，不把协作请求当作停止确认。
- [x] 失败时保留临时证据目录，读取缓存 detail 和本地日志，避免额外无期限 socket 请求；成功时清理。第二轮 red 与加载时回退共 16 个失败目录已逐一确认保留。
- [x] 测试提交版本的类型检查、相关 CLI/socket 四文件 101 passed、最终显式串行全套 214 passed / 20 skipped。完整命令、耗时及合并前补文档后复验进展见 [#29 验收记录的后续维护回归](issue-29-real-acceptance.md)。20 个 opt-in Docker skipped 不计为通过。

三项等待回归分别经加载时回退再次 red，最终代码审查未发现正确性缺陷。上述测试证明等待契约及维护断言在受控场景下成立，不证明 [#49](https://github.com/canxer314/sandcastle-orchestrator/issues/49) 的历史首次事故必然同因或已修复；原事故缺少 DATA 和细分时序，仍待独立证据。较早审查全套的 `pr-analysis.test.ts:97` 失败也保留在 #29 补充记录，不据后续通过撤回。

本次未执行新的真实模型、容器、业务远端写入、备份回退或生产验收。原有真实 SQLite/tar 演练和回退限制不变，失败目录的本地临时留存不承诺长期归档。

## 人工介入和限制

人工介入包括暂停、判断已有执行是否可信结束、离线备份、检查完整性、恢复配置及证据、查阅备份外审计、取消陈旧队列、记录核对和明确恢复。无法确认执行或外部写入时保持暂停，不自动 retry。

测试没有部署生产备份任务，也没有验证真实模型、真实容器、第三方写入、异机恢复、磁盘损坏、大数据恢复或时钟偏差。磁盘损坏最多恢复到可用备份点，演练耗时不能作为生产 RTO 或零丢失承诺。可执行的升级、权限及恢复步骤见 README 的维护章节。

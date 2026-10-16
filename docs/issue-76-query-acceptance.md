# Issue #76 本地验收记录

日期：2026-10-16。基线 `e984d265356e10768fcf36a9225f7acc253c457a`，分支 `issue-76-readonly-queries`，独立 worktree。环境 Linux x86_64，Node.js v24.21.0，pnpm 12.3.4。

## 实现与验证范围

- 保留默认 JSON、按编号 show 的 request/execution/attempts 形状、写入格式与兼容补表、在线 unknown 投影、人工恢复与 serve ready/log 协议。
- 显式 human 查询支持 show/list/logs/artifact/maintenance，严格校验新参数；旧模式的额外参数容忍回归通过。仅查询默认 socket 改为所选 data 下的 control.sock，显式 data/socket 冲突按物理路径比较，符号链接别名通过。
- source/key 查询经真实 socket 验证全部拒绝及接纳的记录顺序、单项仍为数组、无匹配和编号互斥；停服务后通过 CLI 离线得到相同记录。查询不调用 submit。
- 原生 SQLite fixture 与真实 CLI 验证离线读取无需 init 标记、不加载配置、保留 running、日志缺失如实返回。比较数据库字节和目录成员，未创建或修改记录资源。缺失目录、不支持结构、WAL 拒绝保留原件。
- human 分开接纳、执行、attempt、业务原文与证据缺口，维护/产物保留查询元数据。受控 Unix HTTP responder 覆盖故障、原样日志、截断/完整性、产物内容与分段信息、30 秒总等待和 SIGINT 130。中断只收到原 show 请求，不发送取消。错误后的核对命令保留实际实例及证据选择参数。
- README 已检查并修订查询说明，完整使用和只读限制见 [queries.md](queries.md)，附 changeset。

## 命令结果

- `pnpm run typecheck`：通过，实施过程中多次运行。
- `pnpm run build`：通过。
- 相关 CLI/socket 六文件回归：160 passed。此轮之后增加一项审查修复回归，全套已包含。
- `pnpm test --maxWorkers=2`：17 files passed，297 passed / 20 skipped，共 317 tests。含既有安装包消费回归。
- `git diff --check` 与 staged check：通过。

TDD 按 CLI/socket seam 逐段 red→green。`code-review` 双轴审查原发现 Standards 1 项非阻塞重复读取、Spec 1 项核对命令遗漏 selectors；均已修复并分别复核，当前两轴无剩余发现。

## 未验收与边界

未运行真实 Docker、真实模型、私人连接或生产外部写入，20 项 opt-in 测试跳过。受控适配器测试不代替真实 provider 验收。既有 package 消费测试随全套通过，但本增量正式打包消费集成验收仍留给集成阶段；未发布 npm/Release、推送或修改远程 issue。

离线仅支持已测试的现有查询表结构与 DELETE journal 模式，WAL/非空恢复 journal 明确拒绝，不做修复。数据库只读事务不冻结日志和产物，不宣称跨资源快照一致。离线不提供 artifact/maintenance，不建议为看结果而启动可能调度历史任务的服务。写命令 human、输入文件、demo/reset/setup 不属本增量。

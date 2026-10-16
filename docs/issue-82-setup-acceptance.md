# #82 setup 受控验收记录

2026-10-16，Linux x86_64，Node.js v24.21.0，pnpm 12.3.4。基线为已合并 master `80bad49336a9ee7f30a678968215dfb28e411920`，包含 #75、#77、#80。实现位于独立 worktree `issue-82-readonly-setup`，没有读取未合并分支作为依赖。

## 已实现与受控证据

`setup` 只生成入口，保留原 CLI/socket、serve ready、默认管理 JSON、异步 submit、持久化记录和恢复规则。新增公开导出复用 #80 的 `claudeCode`/`ClaudeConnection`，不复制连接投影或 runner，不实现 #81 网络桥。

- CLI 临时 Git fixture 验证根目录与完整 SHA、子目录/显式项目路径、脏树排除、不加载项目 TS、禁用目标 fsmonitor；源 HEAD 和未提交内容保持不变。
- 伪终端验证交互选择、摘要和明确写入确认；非交互/JSON 缺选择或 `--yes` 立即退出。`--yes` 不授权复用私人连接；测试用隔离 HOME 下的合成 settings，不读取真实 HOME 连接。
- 新配置/data/JSON 输入、固定 repo/role、默认或自定义问题、模型继承/显式覆盖、自定义镜像、路径冲突/已有文件/符号链接、reference-only 现有 data 不变及缺失 data 不创建均有 CLI 回归。
- 受控 Docker 二进制 adapter 驱动真实 serve/submit/socket/role/provider，使用显式容器可达测试 endpoint 来源，核对 readonly mounts、固定 SHA、无隐式 model 参数、无认证值持久化，并由 `show --human` 读取有效非空报告。adapter 不运行容器，也不访问 endpoint；不能当作真实容器网络证据。
- 正式 tgz 在源码之外安装后，运行 setup 并加载生成的外部 ESM 配置，经 `--input-file` 提交且查询输入/SHA；execution starts 保持暂停，不读取连接或运行 Docker。
- 生成固定 CLI `2.1.296` 的 Dockerfile 和准备/版本检查命令。build 用 stdin Dockerfile，无配置目录 build context；setup 不执行这些命令。

## 审查

调用 `code-review`，Standards/Spec 两轴独立审查。Standards 发现 Docker build context 可能包含私人配置，已修复并红→绿验证；Spec 发现参考模式仍要求新 data，已允许现有 data 且不写入，并红→绿验证。两个 reviewer 静态复核后均无剩余确定发现。隔离限制不允许 reviewer 直接获取父目录 Git diff，审查依据允许读取的当前文件与固定基线对比，不冒充完整 Git diff 审查。

## 测试运行

实施中多次 `pnpm run typecheck` 通过。定向 CLI/socket/connection 151 项、setup/package/role 40 项通过；后续新增安全及参考模式回归在 setup 定向 9 项通过。

首轮全套并行运行记录为 2 failed、346 passed、21 skipped。失败是既有 connection live-read 等待与 PR-analysis partial-observation-write 断言；不将其隐去。两个文件原样定向复跑 42 项通过，未改相关测试或生产实现。最终门禁使用 `ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_MCP=0 ORCH_REAL_CONNECTION=0 pnpm test --maxWorkers=1`，串行全套 **19 files passed / 1 skipped，350 passed / 21 skipped**，耗时 411.93 秒。串行通过说明未再复现，并不单凭重跑认定首轮失败根因。`pnpm run typecheck`、`pnpm run build` 和 `git diff --check` 通过。

## 合并前集成

合并前同步已合并 master `77359a04c97096d606c8315fbdcc70e04fb01308`，包含 #78 init/doctor 和 #81 执行桥。保留双方 CLI、help、README 与 tgz 消费测试；`--yes` 同时供 init/setup 使用，setup 专属选项仍拒绝用于其他命令。setup 不重写桥，只通过既有 runner 消费受支持环境的 HTTP loopback 桥，相关帮助及文档不再声称桥尚未实现。复用 master 新公开的 `contains` 路径 helper。

集成定向 `pnpm test tests/setup.test.ts tests/package.test.ts` 为 22 passed；`pnpm run typecheck`、build、`git diff --check` 通过。全套 `ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_MCP=0 ORCH_REAL_CONNECTION=0 pnpm test --maxWorkers=1 --testTimeout=20000 --expect.poll.timeout=10000` 为 **20 files passed / 1 skipped，375 passed / 21 skipped**，耗时 417.48 秒。原有九条验收中第5条的真实容器 endpoint/推荐镜像证据仍缺失，清单最多 8/9，任务须保持打开。

集成 Spec 复核发现自定义 demo 仓库/data 子目录未受保护；CLI 新测试实际复现后，新增物理输出路径祖先 `.git`/`init.json` 边界检查，不加载标记或 TS，不覆盖原件。setup 10项、typecheck/build通过；同一完整门禁命令最终 **20 files passed / 1 skipped，376 passed / 21 skipped**，耗时414.27秒。Standards/Spec均静态复核该修复无剩余确定问题；原审查跨worktree差异访问限制保留。

## 未验收

以下为 PR #94 交付时的历史边界。另行获授权后，已补充真实 Docker、自定义/推荐镜像构建与CLI核验、生成命令和本地受控 endpoint 报告证据，见 [后续容器验收](issue-82-container-acceptance.md)。早期推荐构建曾因DNS和容器直连下载受阻，后来通过临时受限构建代理成功，原样命令使用同配方缓存层复验通过。#82第5条证据现已补齐；真实模型/私人连接仍未验收，不影响其历史边界记录。

未读取私人连接、运行真实 Docker/原版容器 CLI、构建推荐镜像、拉取镜像、调用真实 provider/模型、产生模型费用或发布包。推荐 recipe 使用固定 Node/CLI 版本，但基础标签和 apt 包不按 digest 固定；需在授权环境构建并记录实际 image ID。

#80 的历史真实 Docker 对受控 endpoint 证据见 [独立记录](issue-80-docker-acceptance.md)，不等于本票生成镜像或真实项目问答验收。setup 成功、completed、contract valid、受控报告均不能替代真实模型答案质量或测试通过。#82 的真实镜像/连接/模型验收仍未完成，不能据本次本地提交关闭完整验收。

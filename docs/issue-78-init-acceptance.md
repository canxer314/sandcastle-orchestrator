# Issue #78 初始化与 doctor 交付记录

基线为已合并 master `80bad49336a9ee7f30a678968215dfb28e411920`，在独立 worktree 的 `issue-78-init-doctor` 分支实现。前置 #74 已包含在基线，未读取或依赖其他功能票的未合并代码。

## 实现范围

- 新增 `init`、`doctor`，默认可读，支持 JSON。保留既有管理命令默认 JSON、socket、记录结构、配置部署 version、迁移和恢复路径。
- 默认生成分离的 ESM 配置、data/init.json、已提交演示 Git 仓库。标记记录布局版本和实际资源路径/ID，不保存凭据。
- 完整资源重复复用，不写标记、配置或 Git index。配置与仓库用户修改允许；冲突、不完整、未知布局均停止并保留现场。
- 物理路径、符号链接等价、目录包含、安装目录及业务 Git checkout 保护。自定义 data 的标记可定位资源，显式路径不一致则拒绝。
- 交互写入前显示计划和询问；非交互/JSON 缺少 `--yes` 立即退出。doctor 不安装、拉取、修复或执行任务，缺条件给修复步骤。
- 模板无第三方运行时 import，沿用 execution capability 和完整 SHA 契约。`demo`、reset、setup 均不在本票。

## 验证方式

主 seam 为源码树外独立 prefix 安装 tgz 后的正式 CLI 子进程与 Unix socket，观察 stdout/stderr、退出码、资源变化和执行证据。使用 PATH 上受控 Docker adapter，未运行真实 Docker。

`tests/package.test.ts` 新增验收覆盖默认/自定义路径、cwd 相对路径、PTY 接受/拒绝、非交互拒绝、JSON 输出、依赖缺失/镜像缺失、未初始化 doctor、资源冲突、目录包含、符号链接、用户修改、未知/不完整/缺失标记，以及生成配置经 CLI/socket 的提交、固定 SHA、业务结果和日志。初始红灯为旧 CLI 不支持 `--yes`；后续红灯覆盖配置日志污染 JSON 和无标记资源冲突，修复后定向通过。

验证环境：Linux x64、Node.js v24.21.0、pnpm 12.3.4。

- `pnpm run typecheck` 通过。
- CLI/socket 定向 4 files、156 tests 通过。
- `tests/package.test.ts` 12 tests 通过。
- 首次并行全套 339 passed、21 skipped、6 failed。失败包括多子进程用例 5 秒超时，以及既有连接、启动和 PR-analysis 时序断言。串行 `pnpm test --no-file-parallelism` 全套 18 files passed / 1 skipped，345 passed / 21 skipped。
- Standards 审查发现损坏 Git metadata 的路径保护 fail-open。先以损坏 `.git` 的正式 CLI 用例复现，再改为核对 `.git` 祖先并拒绝无法确认的 Git 状态；包含判断复用 `paths.ts`，未改变旧调用行为。
- Spec 审查发现自定义配置目标预检不足。以 `--config package.json` 留下半成品和 `.js` 生成不可消费 TS 的测试分别复现，修复为写入前拒绝 ESM 文件碰撞、新模板仅使用 `.ts/.mts`，不缩小 serve 的旧配置兼容范围。
- 两轴定点复核均无未解决项。隔离 hook 禁止审查 agent 跨 worktree 读取 Git diff；审查使用已知修改清单直接读取文件和基线相关调用者，保留这一范围限制。
- 修复后 typecheck、安装消费 12/12 通过。中间全套复跑因新增修复而主动停止。最终 `pnpm test --maxWorkers=2` 全套通过，18 files passed / 1 skipped，345 passed / 21 skipped，耗时 216.76 秒。生产构建及 `git diff --check` 通过。

## 未验收

真实 Docker/镜像执行、真实模型、私人连接、远端认证与发布渠道均未运行。本票不提供 demo 生命周期，不能以 doctor 成功或受控业务结果声称首次真实本地测试通过。未发布包、push 分支、创建 PR 或修改远端 issue。

# #86 正式发布与渠道验收

2026-10-17，用户明确授权发布后，已发布 `@canxer314/sandcastle-orchestrator@0.1.0`，并完成正式 npm 固定版、latest 与 Release 附件的源码外安装和真实 Docker 快速开始。README 首屏在这些验证通过后才切换。准备阶段及 npm 认证失败历史见[准备记录](issue-86-release-preparation.md)。

## 版本与真实渠道

- [npm 0.1.0](https://www.npmjs.com/package/@canxer314/sandcastle-orchestrator/v/0.1.0)，`latest=0.1.0`，访问级别 public。
- [GitHub Release v0.1.0](https://github.com/canxer314/sandcastle-orchestrator/releases/tag/v0.1.0)，tag 目标为 `a01d0d1dd3b3c4704ebd7b5493ffa03759d301e7`。
- [Release 实际附件](https://github.com/canxer314/sandcastle-orchestrator/releases/download/v0.1.0/canxer314-sandcastle-orchestrator-0.1.0.tgz)名为 `canxer314-sandcastle-orchestrator-0.1.0.tgz`。
- [npm 实际 tarball](https://registry.npmjs.org/@canxer314/sandcastle-orchestrator/-/sandcastle-orchestrator-0.1.0.tgz)已下载，SHA-512 SRI 与 registry 的 `dist.integrity` 相符。
- 两个远端下载原件与 #85 最终候选的 SHA-256 全部为 `057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562`，共 89 个包内文件。没有重新打包上传或以源码归档代替附件。

登录账号经 `npm whoami` 确认为 canxer314，与个人 scope 一致。用户启用 2FA 后，账号状态为 auth-and-writes；本次 publish 等待用户在 npm 官方页面验证后返回成功。发布后 ACL 确认该账号对精确包名有 read-write，包为 public。未创建或扩大 token，没有修改用户服务、数据或模型连接。

版本仍为已验收的 0.1.0；README/指南发布后更新仅进入源码，本次没有覆盖已发布包。新增 `.changeset/issue-86-published-guides.md` 为未来包版本记录文档变更，不声称该 changeset 已发布或将版本临时升为未经验收的新包。

## 安装与真实快速开始

环境：Linux 7.0.0-34-generic x86_64、Node v24.21.0、npm 12.0.2、Git 2.53.0、util-linux flock、Docker client/server 29.8.1。真实镜像 `node:22.22-alpine` ID 为 `sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd`，沿用已准备镜像，未拉取新镜像。本轮未调用模型或读取私人连接。

安装分别位于 `/tmp/issue-86-published/npm`、`release`、`latest` 下，每处有独立 HOME、prefix、cwd 和 npm cache；生产依赖允许联网下载，不用开发源码或开发 node_modules 补足。具体 argv/stdout/stderr/退出码见 `commands.json` 与 `latest-flow.json`：

```sh
# 各自在全新环境中执行，PREFIX 指向本轮对应的独立安装目录
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator@0.1.0
npm install --global --prefix "$PREFIX" ./canxer314-sandcastle-orchestrator-0.1.0.tgz
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
# 每个环境都通过安装目录内的正式命令验证
"$PREFIX/bin/sandcastle-orchestrator" --version
"$PREFIX/bin/sandcastle-orchestrator" --help
"$PREFIX/bin/sandcastle-orchestrator" init --yes --json
"$PREFIX/bin/sandcastle-orchestrator" doctor --json
"$PREFIX/bin/sandcastle-orchestrator" demo --json
```

三个环境的版本均为 0.1.0，init/doctor/demo 均退出 0。非交互验证显式使用 --yes/--json；交互确认与输出分支由既有候选测试覆盖，不把这次非交互运行写成交互终端验收。

- npm 固定版：执行 `5766020e-100e-4876-b11f-933a277289bd`，attempt `1dc10172-5167-41b9-b585-185b4cceff99`，实际 SHA `cf46659974c255b4ac4bd0cbbbd955a7f8798ff0`。
- Release 附件：执行 `127a781e-16ba-47fd-b607-663734fe83e3`，attempt `4ea31ff1-96b2-4498-8868-f9b25ab83f82`，实际 SHA `38b61c11b3ab72f8af302a77ae7c8072dd5a06d5`。
- npm latest：执行 `c590336f-ffbd-4701-b2f0-6d124ac7bd64`，attempt `9957f374-637e-4fef-87ec-eaad89561348`，实际 SHA `5fad56b0fc0208cf03be21e1338f8184d084a2a3`。

每次分别确认：

1. demo 的 testResult=passed，固定 SHA 的实际 Node 测试日志保留。
2. executionStopped=true；另从离线 show 取得实际容器名，运行真实 docker inspect，核对 Running=false、Status=exited、ExitCode=0。
3. serviceExited=true；另以主机 PID 存在性检查确认本次控制服务已不存在，PID 分别为 2416520、2418146、2434316。
4. serviceLog 与 attempt stdout.log/stderr.log 均存在，testLogs.complete=true。原始 journal、SQLite、Git 仓库和日志保留，不运行 cleanup、不删除证据容器。

依赖修复另以 npm 正式安装版运行 doctor：只在该子进程的 PATH 中提供真实 node/git/flock，省去 Docker CLI。doctor 退出 1 并提供 `https://docs.docker.com/engine/install/` 指引。正常 PATH 下真实 doctor 已通过。未卸载主机 Docker、修改权限或破坏镜像。此项验证缺依赖诊断和指引，不声称执行了系统软件安装。

## 失败、限制与证据

首次发布因账号没有 2FA 返回 E403，读回仍为 E404，未盲目重试；用户完成 2FA 后才再次发布。成功回执说明 registry 尚在处理，初次正式消费查询也为 E404，保留于 `initial-propagation-failure.log` 和 `initial-propagation-commands.json`。等待公开版本可见后才完成渠道安装，没有把发布命令成功等同渠道已通过。

本次真实验证是正常首次路径与依赖缺失指引。真实失败、中断、模型/代理切换、维护恢复仍沿用 #85 的分项证据及其限制，不将 unknown 算安全停止；未扩大为所有 Docker/后端、任意历史版本兼容或离线安装保证。安装、发布和文档更新未加载用户配置、重启用户服务、迁移用户数据库或改变 harness/CC-Switch。

README 后续维护与高级能力正文保留，用户/部署指南仅调整入口与状态说明；固定版本命令均使用实际 0.1.0。包内旧 README/指南是候选原件内容，Release 说明指向线上新版；未来更新包内文档需正常发新版。

本轮发布后文档验证：`pnpm run typecheck` 通过；安装/CLI/socket 4 文件 152 项通过，80.25 秒；`pnpm test --maxWorkers=2` 为 21 文件通过、2 文件跳过，401 passed / 22 skipped，241.18 秒。10 份文档的本地链接与 shell 语法检查通过。Standards / Spec 双路复核均为 0 项实质发现。跳过项不算本轮真实验收；本地测试重打包仅验证更新后的源码文档，不上传或替换正式原件。

原始证据目录为 `/tmp/issue-86-published/`，含 channels.json、results.json、commands.json、latest-flow.json、doctor-repair.json、下载 tgz 及三个隔离环境。持久归档位于 `/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-86-published-0.1.0/`，根目录权限 0700，含逐文件 `sha256.json`、渠道/执行/日志记录、验证脚本、测试日志及下载原件。`runtime-evidence.tar.gz` 保留三个隔离 HOME 下的配置、Git 仓库、SQLite、journal 和日志，SHA-256 为 `5695ea3f839f309c2a6500f27b1222974a2bd09b1aa9e3eb058940f9cd86d2e2`。不归档 npm cache、安装 prefix 或私人凭据。父票 #65 的正文与状态未改。

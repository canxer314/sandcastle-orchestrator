# #85 候选安装产物分项验收

本报告针对本地候选包，不是 npm/Release 发布验收。首次本地测试、日常兼容、真实 Agent 接入分别判断；未运行的项目不计通过。#85 与父票保持未完成，正式首页入口不切换。

## 候选来源与重现

基线 `fc02b2c0edf38e305ff1a9dd6237920e5923ec10`，叠加本票提交的文档、包内容和集成测试改动。包版本 `0.1.0`，不能仅凭版本号区别同版候选；实际 tgz 的 SHA-256、源码基线及构建时已跟踪文件 diff 记录在 `candidate-evidence.json`。最终门禁前已暂存本票文件，diff 包含已暂存改动；未跟踪文件通常不在 diff 中，实际候选仍以 tgz 哈希为准。

验证主机 Linux x86_64，内核 `7.0.0-34-generic`，Node `v24.21.0`，npm `12.0.2`，维护者 pnpm `12.3.4`。消费者安装使用 npm，不依赖全局 pnpm。生产依赖按 tgz 安装，类型消费项目自行安装 TypeScript 和类型声明，不从开发仓库借用依赖。

```sh
pnpm run typecheck
ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_CONNECTION=0 ORCH_REAL_SETUP=0 \
  ORCH_KEEP_PACKAGE_EVIDENCE=1 pnpm exec vitest run tests/package.test.ts
ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_CONNECTION=0 ORCH_REAL_SETUP=0 pnpm test --maxWorkers=2
```

包测试先执行 `npm pack --json --pack-destination DIR`，再从源码外的 `DIR/unrelated` 执行 `npm install --global --prefix DIR/prefix --omit=dev --no-audit --no-fund DIR/包名.tgz`。DIR 是新建临时目录，由测试实际打印；完整命令参数见 `tests/package.test.ts`。保留模式留下 tgz、安装目录、生成配置、执行记录和日志；默认回归仍自动清理临时资源。测试停止自己启动的服务，不保留后台服务。

## 实现及受控覆盖

依赖 #75–#84 已合入上述基线。下列测试是本票回归入口，不能替代各模块独立测试，也不能证明真实容器或模型已工作。

- 包消费 `tests/package.test.ts`：编译 ESM、bin、帮助/版本、包外 TS 配置和相对 import、公共类型/value import、目录物理冲突；安装后角色教程的提交、报告和任务组合；实际 init/setup 资源、连续 demo、reset、离线历史和日志、卸载/重装/本地版本替换。替换版本只改版本号，不冒充历史发布兼容。
- 首次路径 `tests/demo.test.ts` 与包测试：默认/自定义路径、确认、保护、缺依赖/镜像、当前 HEAD、dirty 提醒、成功/失败、重复运行历史、服务所有权/ready、遗留任务、固定预算、两次 Ctrl+C、回执丢失和 unknown。Docker 和故障时钟为受控替身，停止证据只在该受控范围成立。安装包组合测试覆盖成功路径；失败、中断、预算与回执丢失目前由源码级 CLI/socket 测试覆盖，不能称为安装包故障路径已全部复验。
- 日常管理 `tests/queries.test.ts`、`tests/record-queries.test.ts`、`tests/writes.test.ts`、`tests/management.test.ts`、`tests/human.test.ts`：旧 JSON/退出码/参数容忍、文件/stdin、source/key 全请求查证、超时/中断不自动重发、实例选择、离线不创建/迁移/加载配置/写状态、旧数据与未知布局兼容、持久化状态说明。
- 接入 `tests/setup.test.ts`、`tests/connection.test.ts`、`tests/localhost-bridge.test.ts`、`tests/roles.test.ts`、`tests/role-tools.test.ts`：独立资源、固定 SHA、连接授权和模型选择、setup 不执行、受控 TCP 来源/流式背压/断流/取消。捕获配置或受控 harness 不证明请求最终物理模型。
- 维护 `tests/maintenance-restore.test.ts` 与包测试：暂停、恢复核对、保留配置/记录/日志、兼容旧数据。完整备份和外部副作用核对仍遵循安装与部署指南，不新增自动维护或自动恢复。

## 文档核对

用户指南现在按首次测试、真实项目接入、日常操作、独立角色扩展、维护及高级 implementation 用法分层。README 保留当前源码入口及未发布提示；部署指南保留管理员配置、镜像、凭据、服务及恢复职责。修正安装/初始化指南中 demo 不可用的过时说明，包内附完整指南和角色示例，避免安装消费者的本地链接缺文件。

包测试实际消费安装、外部配置、初始化、doctor、setup、提交/查询、角色示例和维护命令。demo 命令本轮仅使用受控 Docker。文档中的真实镜像准备、真实接入、人工备份恢复及高级远端发布操作不是本轮已执行清单；占位 ID/路径继续按实际输出替换，不能当作本次结果。

## 真实执行与分项结论

首次本地测试：实现及受控组合已覆盖，真实 Docker 通过/失败、提交 HEAD、dirty 提醒、历史保留与关键中断链路本轮未验收。没有读取 daemon、镜像或 harness 实际版本，没有启动真实容器或拉镜像；因此相关实际版本记为未采集，模板标签不是运行证据。需要在另获授权环境分别保存 attempt 日志、执行停止与服务退出证据，unknown 不算安全停止。

日常兼容：受控回归及包消费结论见下方本轮执行结果；正式渠道安装、跨历史版本与真实环境全流程未验收，不能据此关闭整票。

真实 Agent 接入：setup 生成及受控组合已覆盖，真实只读问答、DeepSeek 直连、CC-Switch ChatGPT、直连切换、运行中代理切换/路由限制、默认/显式模型和自动桥容器 harness 路径本轮未验收。没有读取私人连接、调用付费模型或写远端。历史 #80/#82 的真实容器加受控 endpoint 记录仅作为背景，既不替代本候选复验，也不证明真实后端或物理模型。

本票要求这些真实操作另获授权；当前实施指令未指定授权环境、测试仓库、连接来源和费用范围，因此未执行。发布与正式首页切换继续由 #86 承担。

## 本轮执行结果

`pnpm run typecheck` 通过。首次默认并行全套为 400 passed / 1 failed / 22 skipped，失败为既有 `tests/roles.test.ts:42` 等待 running 时仍为 starting。该文件原样单独复跑 26 passed；随后 `pnpm test --maxWorkers=2` 为 21 files passed / 2 skipped、401 passed / 22 skipped，耗时 238.68 秒。未放宽断言或产品预算，未声称已证明首轮超时根因。完整套件覆盖上述 CLI/socket、连接、role 和维护模块。

最终文档清单补齐 README 的历史记录链接后，另复跑包消费及全部包内 Markdown 本地目标检查。实际结果与最终候选哈希见下。

执行日志保存在本机 `/tmp/issue-85-evidence/`：`red.log` 是文档缺失的失败复现，`package.log` 是首次组合测试的断言失败，`package-final.log` 是修正后 17 项通过，`full.log` 是默认并行失败，`roles-rerun.log` 是单文件通过，`full-final.log` 是低并行全套通过，`typecheck.log` 是最终类型检查。组合测试初版把显式服务启动造成的目录修改计入安装保留比较；已将服务加载检查移到换版循环之后，保留断言不变。

静态审查分两路进行。Standards 无具体违规或需处理的 smell；Spec 无阻塞偏差，指出安装包故障覆盖范围和构建 diff 未跟踪文件限制，现已明确记录。最终门禁先暂存全部本票文件，使用 `git diff HEAD --binary` 保留已暂存内容。

这些 `/tmp` 证据是本机留存，不保证重启后的长期归档；发布判断前应归档所需原件。本报告与最终说明没有修改父票状态，没有发布 npm/Release 或切换 README 正式入口。

## 最终候选原件

最终包消费测试 17 passed，耗时 37.90 秒，日志 `/tmp/issue-85-evidence/package-release-candidate.log`。README 和已打包指南中的本地 Markdown 链接目标全部存在。

- tgz：`/tmp/orch-package-c8vgoX/canxer314-sandcastle-orchestrator-0.1.0.tgz`
- SHA-256：`e762f394887bf61c24bfbe9702e7fc8aa379961aa76ab80b5a7db7e967c9054a`
- 构建元数据：`/tmp/orch-package-c8vgoX/candidate-evidence.json`
- 安装 prefix：`/tmp/orch-package-c8vgoX/prefix`；操作 cwd：`/tmp/orch-package-c8vgoX/unrelated`。
- 默认演示 data：`/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/data`；setup 资源：`/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/projects/candidate`。
- 实际受控执行 `bcde83e3-ab99-46aa-b360-a7d1c6cb86f6`，attempt `210eaa1c-ad09-4b46-bd96-5371e0a43a4c`，SHA `8f546751ff74decd0dfa1e552c61cc18d6e81fe1`；journal `/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/data/demo-runs/105f7290-d740-4731-8a5e-d3aad40b3afc.json`，stdout `/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/data/attempts/210eaa1c-ad09-4b46-bd96-5371e0a43a4c/stdout.log`。预期为受控测试通过、停止及服务退出确认、重复运行保留历史；实际 `testResult=passed`、`executionStopped=True`、`serviceExited=True`，离线 list 保留两条记录，reset 与换版后日志内容不变。
- 实际受控执行 `d442e0a5-29ab-415d-a643-f8d30f47edcb`，attempt `e1f700c3-8dcf-4350-aa30-31410deb49ab`，SHA `8f546751ff74decd0dfa1e552c61cc18d6e81fe1`；journal `/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/data/demo-runs/7bbe986b-7610-4048-9a1c-9eca4943fb09.json`，stdout `/tmp/orch-package-c8vgoX/integrated-home/.sandcastle-orchestrator/data/attempts/e1f700c3-8dcf-4350-aa30-31410deb49ab/stdout.log`。预期为受控测试通过、停止及服务退出确认、重复运行保留历史；实际 `testResult=passed`、`executionStopped=True`、`serviceExited=True`，离线 list 保留两条记录，reset 与换版后日志内容不变。

以上编号来自本轮实际受控输出，不是示例，更不是实际 Docker 执行证据。最终报告补录发生在打包之后，报告不包含在候选包中；最终 tgz 的产品代码、指南及示例与已验证内容一致。

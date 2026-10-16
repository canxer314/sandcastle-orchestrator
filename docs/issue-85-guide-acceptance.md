# #85 指南命令与备份恢复补验

本轮从 master `0aebada2475507238558c91bba136f7708419f3e` 创建独立 worktree `issue-85-guide-acceptance`，补齐 #85 第 14 项。既有候选、Docker、模型及代理验收见[受控报告](issue-85-candidate-acceptance.md)与[真实验收报告](issue-85-real-acceptance.md)。本轮没有改变产品接口、数据格式或模型连接。

## 指南命令覆盖表

这里按用户操作归并重复命令，不将源码回归、安装产物消费、真实后端执行混成一种证据。历史记录中的源码入口 `pnpm start` / `pnpm --dir "$APP" exec tsx src/cli.ts` 在候选消费时替换为已安装的 `sandcastle-orchestrator`；其余管理参数保持原契约。

| 指南与操作 | 候选消费证据及范围 |
| --- | --- |
| installation：tgz 安装、版本、帮助、外部 TS 配置、公共类型/value import | `tests/package.test.ts` 真实 npm 安装与类型消费；不借用源码依赖。卸载、重装、本地改版本号换版保存 init/setup 资源。不是跨历史发布版本证明。 |
| onboarding / demo：默认与自定义 init/doctor/demo、确认、dirty、失败、reset | 包测试覆盖保护分支；真实报告记录候选 CLI 的 Docker 成功/失败、固定 HEAD、重复历史、两次中断及 unknown。依赖安装和镜像拉取提示不是 CLI 自动执行授权。 |
| setup / connection-projection：独立/复用连接、继承/覆盖 model、serve/submit/show | 实际生成资源及真实 DeepSeek / CC-Switch 问答、自动桥、来源切换和同执行代理切换；harness 镜像实际版本已记录。镜像构建示例是准备方法，本轮使用既有镜像，不声称重新构建。 |
| queries / submissions：JSON、human、文件/stdin、来源键核对、在线/离线证据 | 包消费及 CLI/socket 回归覆盖；本次安装命令读取 list/show/logs/artifact/maintenance。失败及未知回执由受控故障测试补充分支，不冒充真实网络事故。 |
| readonly-role-tutorial：外部配置、只读 role、报告产物、工具与任务组合 | 包测试 `readonly tutorial works as a package consumer through submit, show and report artifacts` 使用安装版 CLI 与受控 provider，验证两份教程配置；真实只读模型证据另见真实报告，不宣称受控组合实际调用模型。 |
| README / installation：pause、离线一致备份、恢复资源、restore-review、resume | 本轮脚本使用安装版 CLI、真实 Docker、sqlite3 和 tar；完整过程见下文。修正 README 的固定历史 backup-point 为读取本次备份记录。 |
| deployment-guide：test-commit 与日常运维 | 包消费的固定 SHA Docker capability、真实 demo 日志/产物与本轮恢复组合验证公共命令。本轮另用受控 Docker 替身通过安装版 CLI 验证 confirm-stop、retry、resolve、cleanup；PID 独立查证后才确认停止。cleanup 对新证据返回空清理列表，30 天删除/partial 等分支仍由维护回归验证，不能把未到保留期的文件强行删除。 |
| user-guide / deployment-guide 高级 implementation、Draft PR、PR analysis | 保留既有管理员部署与授权前提；示例命令的提交/查询契约由包消费和 role/工具测试核对。本轮不创建远端 Draft PR、不向业务仓库写代码，不将历史真实记录计作本候选远端发布验收。 |
| npm latest / 固定正式版本 / Release 同一 tgz / 正式 README 首屏 | 属于 #86；本候选未发布，命令明确标为发布后使用，不能执行后虚报正式渠道已验收。 |

覆盖表用于核对完整指南的可执行候选路径和适用范围，不代表每条环境安装命令、每种真实故障或高级远端副作用都已发生。以上显式条件与非本票发布操作不提升为额外关闭门槛，也不被勾选为真实通过。

## 可复跑的安装版演练

脚本为 [`scripts/acceptance/issue-85-backup-restore.py`](../scripts/acceptance/issue-85-backup-restore.py)。它只通过已安装 CLI/socket、主机 sqlite3/tar/Git/Docker 操作，不 import 产品源码；不读取私人模型连接。需要 Python 3、Node 24+、npm 缓存中候选生产依赖、Git、sqlite3、GNU tar、Docker 及已准备的 `node:22.22-alpine`。显式运行会启动真实 Docker；不进入默认 `pnpm test`。

```sh
python3 scripts/acceptance/issue-85-backup-restore.py \
  /absolute/path/to/candidate.tgz /absolute/path/to/new-private-drill-directory
```

第二个目录必须不存在；脚本拒绝覆盖。它保留成功和失败的所有记录。运行失败后应先查 commands.json 和服务日志，核对实际执行与容器停止；finally 只停止本次控制服务，不把服务退出当作执行停止。重新运行必须指定新的目录。

1. 用独立 HOME、prefix、cwd 离线安装真实 tgz；init 生成演示资源，setup 只生成独立资源，使用 example.invalid 参考连接，不启动模型。
2. 在生成的 demo 配置中显式添加 report.txt 产物，运行真实 Node 测试并核对报告内容 `BACKUP_85`。保存已提交 SHA，同时保留未提交文件和外置 input。
3. 暂停 starts，接纳一条确定性排队请求，再暂停 all；list/show 确认队列没有 attempt，Docker inspect 确认已完成执行停止，再停止控制服务。
4. 执行指南的 `.backup`、副本 `integrity_check`、完整 data/config tar，并另备份 inputs、含 .git 和 dirty 文件的仓库、完整 setup 资源。备份位置与源目录互不包含，根目录权限 0700。
5. 原实例以 paused 启动，经显式 resume 完成备份时排队的请求，将实际执行记录留在备份外独立 audit 目录，再独立确认容器停止。这是本地已知副作用，不涉及模型或远端。
6. 恢复到全新独立目录；所有归档资源解包后逐文件比对 SHA-256，再显式调整恢复配置和 init 标记的路径，原件不改。恢复 SQLite integrity_check 为 ok。
7. 用 `--maintenance restore` 启动，show/logs/artifact 与备份前完全一致。未 review 的 resume 退出 1，错误为 `Restore review required before resume`。依据独立审计取消备份中的陈旧队列，再记录真实 backup-point、handling、external-results。review 后仍暂停，显式 resume 后才恢复；陈旧请求保持 cancelled、无 attempt，没有再次执行。
8. 服务停止后，核对原实例资源、原 SQLite 字节、独立审计及恢复仓库 dirty 文件保持不变。备份保留，不自动 cleanup 或删除证据容器。

额外的隔离恢复命令 fixture 使用受控 Docker 替身：run 子进程退出，但 inspect 故意报仍在运行，产生 unknown。独立检查该 PID 已不存在后才 confirm-stop；显式 retry 生成第二次 attempt 并完成，另一条 unknown 经 confirm-stop/resolve 变为 resolved。cleanup 保留新证据、logs 仍可读。这部分是受控进程与安装版 CLI 验收，不是真实未知容器恢复。

这是单机临时磁盘演练，不是已部署备份计划、异机灾备、磁盘损坏恢复或 RTO 承诺。没有关闭真实模型容器制造停止结果。

## 本轮实际结果

最终脚本运行目录 `/tmp/issue-85-guide-verified`，独立 prefix `/tmp/issue-85-guide-verified/prefix`、cwd `/tmp/issue-85-guide-verified/cwd`、HOME `/tmp/issue-85-guide-verified/home`。Node `v24.21.0`，Linux `7.0.0-34-generic` x86_64，Docker client/server `29.8.1`；镜像 `node:22.22-alpine` ID `sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd`。本轮没有模型 harness 执行。

- 新候选版本 `0.1.0`，SHA-256 `057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562`。tar 内容与上一轮候选逐文件比较，仅 `package/README.md` 改变，产品字节一致。新报告和验收脚本是仓库交付，不放入产品包。
- 首次真实执行 `3d50318b-dcc4-45e4-abf5-67894f13eed7`，固定 SHA `0ae8f788122c81a2aaa098c0b9c1e8b49fb4672e`；测试通过，report.txt 内容正确，Docker inspect 独立确认停止。
- 备份开始时间 `2026-10-16T18:56:43Z`。备份后原实例完成 `371421d2-eb0c-4cc7-b9c7-e778ef8e6c3c`，独立 audit 保留实际结果与容器停止记录；恢复副本中的同一请求取消后仍无 attempt。恢复启动至审核、resume、停止及原件校验约 `1.065` 秒，只是该小型本机数据的实测时间。
- 安装版受控恢复命令：retry 执行 `b0a77a2d-74ef-4caf-8c78-1320bc663aa8` 保存两次 attempt；resolve 执行 `16dfc0fe-d7b5-4b2e-8705-eee5c210438f` 状态 resolved；cleanup 返回 `{"attempts":[]}`，新日志保留。独立 PID 缺席检查先于人工停止确认。
- `pnpm run typecheck` 通过；`pnpm test --maxWorkers=2` 为 **401 passed / 22 skipped**，253.92 秒；最终 `pnpm exec vitest run tests/package.test.ts` 为 **17 passed**，41.80 秒。没有过滤失败、放宽断言或调用模型补常规测试。
- 两路代码复核完成。Standards 指出的超时输出遗漏已修正；Spec 指出的安装版恢复命令缺口已补。最终无阻塞发现。

脚本调试失败也保留：第一次遗漏传统 JSON 命令要求的 socket 参数；第二次将 restore 未审拒绝错误地预期为成功回执；受控恢复初版误将 role Docker binary 配置当作确定性执行的选择方式，随后改为已支持的 PATH 替身。三次均为脚本错误，未计作验收通过；失败输出和命令记录归档。最终脚本捕获启动异常/超时，先保存 argv 及已有输出，再抛错；不凭失败后的服务停止认定执行已停止。

持久本地归档 `/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-85-guide-0aebada/`，权限 0700，含候选 tgz、metadata.json、sha256.json、evidence.tar.gz。证据包含最终命令输出、服务日志、数据库、备份、恢复副本、独立审计、脚本、测试日志和上述失败记录；不含安装 prefix/node_modules。未访问或归档私人模型凭据。

- `evidence.tar.gz` SHA-256：`e40eeffac41ed0a2816e43368ee5680b3c562c4d4204960e48e95edbc44d6ff2`。
- `metadata.json` SHA-256：`4648a1296b807b08542a8ecfd086d0259a84ebb5a91519c70152692a7cebcf0c`。

第 14 项的候选消费缺口已补齐。正式渠道、README 正式首页切换及高级远端发布不冒充本次交付；本轮只提交当前独立分支，不创建、合并 PR 或发布包。

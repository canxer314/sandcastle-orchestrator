# 演示测试与重置

`demo` 使用 `init` 创建的配置、data 和演示 Git 仓库，启动本次专属控制服务，经 Unix socket 提交一次 deterministic Docker 测试，然后等待结果并结束本次服务。不需要模型账号，不自动拉镜像。先按[初始化说明](onboarding.md)准备资源并运行 `doctor`。

```sh
sandcastle-orchestrator demo
# 自定义初始化时，继续指定同一个 data
sandcastle-orchestrator demo --data /srv/demo/data
sandcastle-orchestrator demo --data /srv/demo/data --json
```

`--config FILE`、`--demo-repo DIR` 可以显式指定，但必须与所选 data 的 `init.json` 指向同一物理资源。相对路径以当前目录为准；配置是会执行宿主代码的可信 TypeScript，加载前打印实际路径。默认可读，`--human` 可显式选择；`--json` 的 stdout 仅含机器结果，诊断和阶段提示写 stderr。两种模式互斥，多余参数在加载配置前拒绝。

每次解析当时 HEAD 的完整 SHA，并固定执行该版本。修改后自行 commit 再运行 demo，可测试新版本。存在未提交修改时只提醒“仅测已提交版本”，不替你 commit、清理或切换分支。演示 capability 沿用 init 的 `{ business: { passed, exitCode } }` 契约，结果必须与实际 SHA、容器退出证据一致。任意 `completed` 或任意 `passed` 字段都不单独代表测试通过。

## 等待与退出

服务启动预算 30 秒。本次子进程的 ready 通知和预期 socket 的只读查询都成功后，才提交一次。执行等待预算 5 分钟，取消与服务退出共用另外 30 秒。预算固定，不改变日常 capability 的执行期限，也不自动重试。

第一次 Ctrl+C 阻止后续提交；若已经执行，则请求取消并核对实际停止，再请求本次服务退出。第二次 Ctrl+C 可结束等待。取消回执、服务退出和 socket 消失都不是执行停止证明。不强杀服务或容器，不把正常 demo 转成后台常驻服务。

- `0`：测试通过，执行停止和本次服务退出都已确认。
- `1`：已确认测试失败、运行故障或前置条件未满足。
- `2`：受理、结果、执行停止或服务退出仍不确定。输出 `unknown`，优先于中断退出码。
- `130`：用户中断且安全收尾。

输出分别列出测试结果、执行停止、本次服务退出。只显示已知的执行/attempt 编号、SHA、服务 PID、socket 和日志路径。日志缺失或不完整会如实报告，存在日志不证明执行停止。收尾预算结束时服务可能仍在退出；CLI 结束等待不等于服务或执行已经结束。

## 证据与排障

每次运行的控制服务日志位于实际 data 的 `demo-runs/<runId>.service.log`，与 attempt 的 `stdout.log`、`stderr.log` 分开。启动失败没有执行编号时仍保留服务日志。正常成功、失败和 unknown 都不删除配置、仓库、记录或日志。

每次 demo 在发送前保存 `demo-runs/<runId>.json`，包含稳定 source/key。回执丢失时只读查询这个组合，绝不重发。没有查到记录不等于可以重试。输出提供带实际 data 的核对命令，例如：

```sh
sandcastle-orchestrator list --data /srv/demo/data --offline --human
sandcastle-orchestrator show EXECUTION_ID --data /srv/demo/data --offline --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/demo/data --offline --human
sandcastle-orchestrator show --source sandcastle-demo --deduplication-key RUN_ID --data /srv/demo/data --offline --human
```

离线查询不启动服务、不加载配置、不调度遗留任务。先查看日志和记录，再独立检查实际容器及 capability 进程。不要仅凭保存的 PID、socket 文件或容器名认领、停止其他进程。涉及 unknown 执行时，继续使用既有的人工 `confirm-stop`、`resolve` 审计机制；它们记录核对结果，不代替停止动作。不要为了查记录而直接启动可能调度遗留任务的日常服务。

同一 data 已有控制服务、未结束/排队/待核对执行，或存在 `settled` 不为 `true` 的 demo 日志时，demo 和 reset 都拒绝继续。前一次已确认结束且没有待核对事项后，下一次手动 demo 才新建执行。失败不会自动再次提交。

异常进程退出可能留下未完成的 demo journal。人工处理时先保留原件，逐项核对 source/key 的全部受理记录、实际执行停止、业务结果和原服务身份/退出；有执行时完成现有记录审计。所有缺口解决后，才可在该 journal 中补充人工核对说明并把 `settled` 改为 `true`。这只解除 demo 客户端的保守保护，不改执行状态，也不会绕过记录库的遗留执行检查。无法确认受理或停止时保持原样，不删除 journal 来重跑。

## 重置演示仓库

```sh
sandcastle-orchestrator init --reset-demo --data /srv/demo/data
# 无交互终端或 JSON 必须明确确认
sandcastle-orchestrator init --reset-demo --data /srv/demo/data --yes --json
```

reset 会说明并询问是否丢弃演示仓库中的全部修改。确认后仅重建演示仓库，保留配置、data、初始化标记、执行历史和日志，不升级配置。成功退出 `0`，拒绝或失败退出 `1`。`--yes` 只省去询问，不绕过路径、完整初始化、服务占用和未确认停止保护。普通 `init` 仍不覆盖资源。链接 worktree 或外部共享 Git metadata 不能作为 reset 目标。

重建先在同级临时目录准备新仓库，再交换目录。若文件系统在交换或清理时失败，保留现场并按报错检查同级 `.reset-*` 目录，不要删除 data 或执行证据。

本阶段 CLI/socket 测试使用受控 Docker adapter 和故障时钟，不能据此宣称真实 Docker 已验收。真实 Docker、模型、外部服务和发布需在获授权环境另行验收。

# 安装并运行无模型账号的演示

首版面向 Linux，要求 Node.js 24+。控制服务还需要 util-linux 的 `flock`；执行任务需要 Git、Docker daemon 和管理员预先部署的可信镜像。不会自动安装系统依赖、拉取镜像、加载用户配置或启动服务。macOS/Windows 请使用 Linux 环境或 WSL，本版本不承诺原生执行。

## 安装正式版本

从 [npm](https://www.npmjs.com/package/@canxer314/sandcastle-orchestrator) 安装正式版本，也可从 [GitHub Releases](https://github.com/canxer314/sandcastle-orchestrator/releases) 下载对应版本的 tgz。安装生产依赖可能联网，不是离线安装。

消费者不需要 clone 仓库、pnpm、全局 tsx 或手工编译。prefix 必须独立于配置、运行数据和业务仓库：

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
sandcastle-orchestrator --help
```

需要固定版本时，在包名后加 `@实际版本`。备用 tgz 应先对照该版本正式发布的哈希核验原件，再运行 `npm install --global --prefix "$PREFIX" /absolute/path/to/package.tgz`。不要安装自动生成的源码归档。

正式命令固定为 `sandcastle-orchestrator`，不会覆盖依赖的 `sandcastle` 命令。无参数、根帮助和子命令帮助不加载配置、不连接 socket，也不创建数据目录。npx 仅用于临时体验，不作为常驻部署方式。

## 初始化演示资源

```sh
sandcastle-orchestrator init
sandcastle-orchestrator doctor
```

`init` 先检查 Linux、Node.js 24+、Git，再展示要创建的目录和文件，等待确认。脚本、管道或 JSON 模式必须显式给 `--yes`，否则立即退出。`--yes` 只跳过询问，不跳过任何路径或配置保护。

默认资源是：

| 资源 | 路径 |
| --- | --- |
| 可信配置 | `~/.sandcastle-orchestrator/config/config.ts` |
| ESM 声明 | `~/.sandcastle-orchestrator/config/package.json` |
| 运行数据 | `~/.sandcastle-orchestrator/data/` |
| 初始化标记 | 所选 data 下的 `init.json` |
| 演示 Git 仓库 | `~/.sandcastle-orchestrator/demo-repo/` |

演示仓库含已提交的 `test.cjs`，用 Node 内置 test runner 运行，不需要模型账号或第三方运行时 import。模板使用现有确定性 capability，输入为完整 commit SHA，执行 `node --test /workspace/test.cjs`，业务结果为 `{ passed: boolean, exitCode: number }`。生成资源不代表已运行容器测试。

## 自定义资源

三个资源及安装目录、业务 Git 仓库不能重合或互相包含。新建配置模板的文件名须为 `.ts` 或 `.mts`，不能占用 ESM 声明 `package.json`；这些条件在任何写入前检查，不改变既有 serve 的配置兼容范围。物理路径与符号链接也按同一规则检查。相对路径从当前 cwd 解析，不向上查找或自动加载业务项目中的 TS 配置。

```sh
sandcastle-orchestrator init --yes --json \
  --config "$HOME/orchestrator-example/config/config.ts" \
  --data "$HOME/orchestrator-example/data" \
  --demo-repo "$HOME/orchestrator-example/repo"
sandcastle-orchestrator doctor --data "$HOME/orchestrator-example/data"
```

后续显式选择同一 `--data`。doctor 从该 data 的标记找到配置和演示仓库，并在 stderr 显示将加载的真实可信配置路径。显式 `--config` 或 `--demo-repo` 必须与标记指向同一物理资源，指向相同资源的符号链接可以使用。没有全局“最近项目”选择。

配置是可信 TypeScript，加载会执行宿主代码，包括 import。doctor 和重复 init 核验配置时也会加载它，不保证用户配置无副作用；普通加载输出转到 stderr。只加载用户选定 data 标记关联的配置，不自动执行 cwd 中的配置。

## 重复初始化和冲突

标记记录布局版本、资源绝对路径及演示 repo/capability ID，不记录凭据。标记和实际配置、ESM 声明、Git 根目录、已提交 HEAD 必须同时有效。完整时重复 `init` 返回 reused，不覆盖配置、修改权限、重建仓库或更新标记。允许同一路径内的配置修改、仓库提交及未提交修改，不要求保留原始 HEAD 或原始文件内容。

没有标记但已有资源、标记缺失字段、配置丢失、路径冲突或资源不完整时，保留现场并退出。不要删除 data、锁、数据库或仓库来重试。先检查报出的实际路径，保留证据，手工核对；若需要全新演示，为配置、data 和 repo 全部选择新的独立目录。init 不接管已有配置目录，即使目录为空，也不会自动补齐或修复。

未知布局版本要求使用匹配的 CLI。布局版本与配置部署 `version`、SQLite 记录结构无关；init 不修改记录或管理协议，也不迁移标记，不影响不依赖标记的既有 serve 和离线查询。

## doctor 会检查什么

未初始化也能检查 Linux/架构、Node 24+、Git、util-linux `flock`、Docker CLI/daemon 和默认镜像，并给出 init 指引。已初始化时还核对标记、目录权限/可访问性、可信配置、演示 Git root/HEAD，以及配置中的 Docker 镜像。检查失败会给具体修复步骤，例如：

```sh
# Debian/Ubuntu，按缺失项由管理员执行
sudo apt-get install git util-linux
# Docker 安装步骤：https://docs.docker.com/engine/install/
sudo systemctl start docker
docker info
# 核对镜像来源与信任后，手动准备模板所选镜像
docker pull node:22.22-alpine
```

Docker 访问权限由管理员配置，不建议用放宽 socket 权限绕过。镜像存在不代表认证有效，也不证明容器能完成任务。环境检查不远端认证、不启动控制服务、不执行容器、不调用模型，不自动安装依赖、拉镜像或修复文件。init 生成资源只需 Node/Git，因此 Docker 未准备好也可以先初始化，再按 doctor 指引准备执行环境。

## 运行演示测试

`demo` 使用 `init` 创建的配置、data 和演示 Git 仓库，启动本次专属控制服务，经 Unix socket 提交一次 deterministic Docker 测试，然后等待结果并结束本次服务。不需要模型账号，不自动拉镜像。先按本页的初始化步骤准备资源并运行 `doctor`。

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

reset 会说明并询问是否丢弃演示仓库中的全部修改。确认后仅重建演示仓库，保留配置、data、初始化标记、执行历史和日志，不升级配置。成功退出 `0`，拒绝或失败退出 `1`。`--yes` 只省去询问，不绕过路径、完整初始化、服务占用和未确认停止保护。普通 `init` 仍不覆盖资源。链接 worktree、拥有其他已登记 worktree 的主仓库，或外部共享 Git metadata，均不能作为 reset 目标。

重建先在同级临时目录准备新仓库，再交换目录。若文件系统在交换或清理时失败，保留现场并按报错检查同级 `.reset-*` 目录，不要删除 data 或执行证据。

初始化、环境检查和 reset 成功退出 0，条件不满足或失败退出 1。它们默认可读，支持 `--json`，机器结果只写 stdout，确认和诊断写 stderr。

演示成功后，按[分析自己的项目](user-guide.md)准备模型连接。取消和 unknown 处理见[查询与恢复](queries.md)，升级和卸载见[部署维护](deployment-guide.md)。

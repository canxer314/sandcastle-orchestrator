# 演示初始化与环境检查

本阶段提供 `init` 和 `doctor`。检查完成后可显式运行 `demo`，重置使用 `init --reset-demo`，详见[演示测试与重置](demo.md)。真实项目入口见 [setup 指南](setup.md)。不要把环境检查通过当成测试已经执行。安装仍见[安装说明](installation.md)，目前只验证本地 tgz，未发布 npm/Release。

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

未知布局版本要求使用匹配的 CLI。布局版本与配置部署 `version`、SQLite 记录结构无关；本增量不改记录或管理协议，不迁移标记，不影响不依赖标记的既有 serve 和离线查询。

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

## 输出与当前验收范围

两个命令默认可读，支持 `--json`，成功退出 `0`，条件不满足或失败退出 `1`。JSON stdout 只包含机器结果，计划、确认和可信配置加载提示在 stderr。`--help` 在没有资源或依赖时也可阅读。

本增量通过源码外 tgz 安装后的 CLI/socket 验证资源生成、复用、冲突保护和模板消费。Docker/镜像分支使用受控 adapter；本票没有执行真实 Docker、远端模型或私人连接验收。`demo` 已提供，生命周期受控证据见 [demo 指南](demo.md)；真实 Docker 验收仍需单独记录。

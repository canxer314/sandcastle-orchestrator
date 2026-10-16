# README 首屏草案，未启用

只有[发布操作](release.md)中的正式渠道和快速开始全部通过后，才用下列正文替换 README 开头至开发入口之前的介绍。其余维护与高级能力说明保留；开发命令移到明确的开发入口下。

---

# Sandcastle orchestrator

在单台 Linux 主机上执行固定 Git 提交的测试，保留结果和日志，再按需接入只读 Agent 或自定义角色。第一次演示只运行 Node 测试，不需要模型账号。

准备 Linux、Node.js 24+、npm、Git、util-linux 的 `flock`、Docker daemon 和可信镜像 `node:22.22-alpine`。macOS/Windows 请使用 Linux 或 WSL。安装与运行不需要 pnpm。

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
sandcastle-orchestrator init
sandcastle-orchestrator doctor
sandcastle-orchestrator demo
```

init 显示将创建的配置、data 和演示仓库，确认后写入。doctor 缺依赖时先按提示修复，再运行 demo；程序不会自动安装系统依赖或拉镜像。demo 测试演示仓库当前已提交 HEAD，分别报告测试结果、执行停止和本次服务退出，并保留控制服务及 attempt 日志。三项确认后才算首次测试通过。后续修改请自行 commit，未提交内容不会进入测试。

依赖缺失看[初始化与修复说明](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/onboarding.md)。路径冲突或 unknown 时保留现场，按[演示排障](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/demo.md#证据与排障)核对本次输出中的实际编号与日志，不删锁、不覆盖配置、不盲目重跑。

继续使用可阅读[真实项目接入](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/setup.md)、[日常查询](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/queries.md)、[独立角色与任务组合](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/readonly-role-tutorial.md)、[完整用户指南](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/user-guide.md)和[部署指南](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md)。固定版可安装 `@canxer314/sandcastle-orchestrator@0.1.0`，备用附件按本版本 Release 说明安装；换版前先阅读[维护与资源保留](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/installation.md#资源保留与手工换版)。安装可能联网下载依赖，不会替你停止、升级或重启运行中的实例。

# Sandcastle orchestrator

把本地 Git 仓库的固定 commit 交给 Docker 中的任务，保留进度、报告和日志。先跑不需要模型账号的测试 demo，再让只读 Agent 解释自己项目的模块与调用关系。

需要 Linux 或 WSL、Node.js 24+、npm、Git、util-linux `flock` 和可用的 Docker daemon。Docker 权限相当于主机管理权限，只在可信主机上授权。

无账号 demo 不调用模型。真实分析会把代码和问题发送给你选定的模型服务，可能收费；先确认代码可分享，并阅读[真实分析教程](docs/user-guide.md)的凭据和权限限制。

## 先运行无账号 demo

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator init
sandcastle-orchestrator doctor
# 缺少镜像时，审查来源并确认允许联网后，手动运行 docker pull node:22.22-alpine
sandcastle-orchestrator demo
```

`init` 写入前显示路径并等待确认；`doctor` 只检查，不自动安装依赖或拉镜像。demo 不调用模型。只有测试通过、执行停止、本次服务退出三项都确认才算成功。遇到 `unknown` 保留现场，不删锁、不盲目重跑。新终端需要重新设置 PATH。

## 按任务阅读

- [安装、环境检查与无账号演示](docs/installation.md)
- [用真实模型分析自己的 Git 项目](docs/user-guide.md)
- [查询报告、排障、取消与恢复](docs/queries.md)
- [自定义角色、能力、MCP 与外部定时提交](docs/readonly-role-tutorial.md)
- [部署、维护、升级、备份与清理](docs/deployment-guide.md)

源码开发、测试和发布流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

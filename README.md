# Sandcastle orchestrator

把一个已提交的 Git 版本交给本机 Docker 中的任务执行，保留进度、报告和日志。可以先运行不需要模型账号的测试 demo，再让只读 Agent 解释自己项目的模块与调用关系。

## 能做什么，不能做什么

- 对固定 commit 执行任务。未提交修改不会进入分析或测试，不会替你 clone、fetch 或 commit。
- 用 CLI 提交、查询任务和阅读报告。服务由你显式启动，没有网页 UI。
- `setup` 为已有 Git 项目生成只读分析入口，不要求先理解内部角色或调度器。
- 管理员可另外配置测试、实现代码、Draft PR 发布和 MCP 工具。这些不是默认权限，也不是只读教程的一部分。

它不是输入任意 Issue URL 就能自动交付 PR 的服务，不会自动合并代码。只读分析不提供测试通过的证据。仓库和 Git metadata 只读，但 Agent 仍有原生 shell、临时写入与网络访问；这不是完全无副作用或防泄漏的沙箱。

## 安装并运行 demo

使用 Linux，或 Windows 的 Linux/WSL 环境。需要 Node.js 24+、npm、Git、util-linux 的 `flock` 和可用的 Docker daemon。macOS/Windows 原生执行不在本版支持范围。安装消费者不需要源码、pnpm 或 tsx。

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
sandcastle-orchestrator init
sandcastle-orchestrator doctor
```

`init` 显示独立配置、data 和演示仓库路径，等你确认后写入。`doctor` 检查依赖并提示缺项，不会自动安装软件或拉镜像。Docker 权限相当于主机管理权限，只在可信主机上授权。

demo 需要本地可信镜像 `node:22.22-alpine`。没有镜像时，确认允许联网下载后自行准备，再检查并运行：

```sh
docker pull node:22.22-alpine
sandcastle-orchestrator doctor
sandcastle-orchestrator demo
```

demo 只测试演示仓库，不调用模型。输出分别确认测试结果、执行停止和本次服务退出；三项确认后才算通过。路径冲突或 `unknown` 时保留现场，按[演示排障](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/demo.md#证据与排障)核查，不删锁、不盲目重跑。依赖与修复见[初始化说明](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/onboarding.md)。安装可能联网，新终端须重新设置 PATH，或把上述 export 加入自己的 shell 配置。

## 接下来：分析你已有的项目

按[主教程：从 Git 项目到只读模块报告](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/user-guide.md)操作。主路线依次准备模型连接、生成项目入口、准备 Agent 镜像、启动服务、提交模块分析、核对报告。

真实模型需要自己的授权连接，可能产生费用，项目代码也会进入所选模型服务。先读教程的凭据、数据和支持限制，再提交。demo 成功不代表模型连接可用。

## 按需查阅

| 需要 | 文档 |
| --- | --- |
| 安装、固定版本、卸载与换版 | [安装说明](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/installation.md) |
| setup 参数、路径冲突、替代连接来源 | [setup 参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/setup.md) |
| 进度、日志与离线证据 | [查询参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/queries.md) |
| 文件提交、丢回执与去重 | [提交参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/submissions.md) |
| 自定义只读分析和工具组合 | [角色扩展教程](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/readonly-role-tutorial.md) |
| 部署、备份、恢复与高级配置 | [管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md) |

0.1.0 已发布到 npm 和 [GitHub Release](https://github.com/canxer314/sandcastle-orchestrator/releases/tag/v0.1.0)。[发布验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-86-release-acceptance.md)记录安装和真实 Docker demo；[指定环境的模型验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-85-real-acceptance.md)不是对所有 provider 的承诺。本次文档重写未调用真实 provider，也未运行 Docker，未验证你的 endpoint、凭据、镜像或答案质量。

<details>
<summary>旧版参考入口</summary>

原 README 的高级配置与维护内容已完整迁到管理员参考，以下保留旧标题锚点。

### 开发与高级配置

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#开发与高级配置)。

### 维护窗口、备份与恢复

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#维护窗口备份与恢复)。

### 提交与查询

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#提交与查询)。

### 确定性执行

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#确定性执行)。

### 主 Agent 额度与排队（#21）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#主-agent-额度与排队21)。

### 单角色报告运行（#19，本地实现）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#单角色报告运行19本地实现)。

### 执行级授权连接与模型继承（#80）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#执行级授权连接与模型继承80)。

### 协作停止与显式期限（#20）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#协作停止与显式期限20)。

### 已有 MCP 服务（#23）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#已有-mcp-服务23)。

### PR 共性问题分析（#25，本地实现）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#pr-共性问题分析25本地实现)。

### 当前尝试 MCP 测试工具（#22）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#当前尝试-mcp-测试工具22)。

### 实现角色到 Draft PR（#24，受控验收）

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#实现角色到-draft-pr24受控验收)。

### 取消与人工恢复

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#取消与人工恢复)。

### 存储升级与回退

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#存储升级与回退)。

### 故障定位与外部通知

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#故障定位与外部通知)。

### 受控演练与处理顺序

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#受控演练与处理顺序)。

### 到期清理

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#到期清理)。

### 验证

见[管理员参考](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/deployment-guide.md#验证)。

</details>

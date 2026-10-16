# Sandcastle orchestrator 0.1.0

尚未完成正式渠道与发布后快速开始验证。本说明是待验证的发布草案，验证完成后才更新为正式结论。下列命令仅在该版本及附件发布后可用。

`@canxer314/sandcastle-orchestrator@0.1.0` 提供 `sandcastle-orchestrator` 命令，用于单机固定提交测试、请求与执行查询、只读 Agent 接入及角色扩展。首次 Docker 演示不需要模型账号。依赖的 `sandcastle` 命令不变。

支持 Linux、Node.js 24+、Git、util-linux `flock` 和可访问的 Docker daemon。演示镜像 `node:22.22-alpine` 需管理员预先准备；不会自动拉取。macOS/Windows 使用 Linux 或 WSL，不承诺原生执行。消费者需要 npm，不需要 pnpm 或源码树；安装生产依赖可能联网。

## 固定版本安装

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator@0.1.0
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
```

备选附件名为 `canxer314-sandcastle-orchestrator-0.1.0.tgz`，须与 npm 原件完全相同，预期 SHA-256 为 `057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562`。在新的下载目录执行：

```sh
gh release download v0.1.0 --repo canxer314/sandcastle-orchestrator \
  --pattern canxer314-sandcastle-orchestrator-0.1.0.tgz
printf '%s  %s\n' 057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562 canxer314-sandcastle-orchestrator-0.1.0.tgz | sha256sum --check
npm install --global --prefix "$PREFIX" ./canxer314-sandcastle-orchestrator-0.1.0.tgz
```

也可在 Release 页面手工下载该附件，无需 gh。不要安装 GitHub 自动源码归档。实际 npm 与 Release URL 待发布后读回记录，此处不将预期 URL 当作已验证渠道。

## 首次演示

```sh
sandcastle-orchestrator init
sandcastle-orchestrator doctor
sandcastle-orchestrator demo
```

init 显示路径并等待确认。doctor 缺依赖时先按提示修复，再运行 demo。demo 测试当前已提交 HEAD，分别报告测试结果、执行停止和本次服务退出，并保留控制服务与 attempt 日志。遇到 unknown 保留现场，按本次输出中的编号和路径核对，不自动重跑。

## 兼容与维护

既有 CLI 默认 JSON、退出码、Unix socket 和已支持的配置/记录兼容路径保留。管理命令的 human 输出须显式选择，init/doctor/demo 等新手命令默认可读。安装、卸载和换版只替换程序，不启动服务、不加载用户配置、不迁移或删除 data、配置、仓库、输入及执行日志，不修改 harness 或 CC-Switch。已有实例按[维护流程](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/installation.md#资源保留与手工换版)暂停、核对、备份并人工恢复，不用 init 覆盖配置。unknown 必须人工核对，不保证任意历史版本可读新数据。

本候选对应主线 `a01d0d1dd3b3c4704ebd7b5493ffa03759d301e7`，候选阶段的受控、真实 Docker/模型与指南补验分别记录于 #85。正式渠道结果须由 #86 补记。包内 README 保留候选阶段文字，发布后[线上 README](https://github.com/canxer314/sandcastle-orchestrator#readme)才更新；不会重打包覆盖同一版本。

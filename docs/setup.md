# 为真实 Git 项目准备只读问答

`setup` 已提供，尚未发布 npm/Release。安装当前 tgz 后可用正式命令；源码开发使用 `pnpm start setup ...`。它只生成入口，不启动服务、提交任务、运行 Docker 或调用模型。

```sh
sandcastle-orchestrator setup --project /srv/my-project
# 也可在项目任意子目录中运行 setup
```

交互时选择连接来源、资源名称和问题，看到项目根目录、完整 HEAD SHA、实际路径及摘要后确认。默认问题为“说明这个项目的主要模块及调用关系”。未提交内容只提醒，不包括在固定版本分析中。不会 clone、fetch、commit、切分支或加载项目内 TS 配置；Git 读取关闭 fsmonitor、hooks 和宿主全局配置。

## 连接选择

非交互必须明确选择来源并加 `--yes`，缺项立即退出。JSON stdout 只有结果；摘要、警告与确认在 stderr。`--non-interactive` 在终端中也禁止询问。

```sh
# 明确授权选用本机当前 settings 来源，不复制 secrets
sandcastle-orchestrator setup --project /srv/my-project --reuse-local-claude --yes --json

# 独立连接文件，setup 不读取它，每次执行前由现有投影加载
sandcastle-orchestrator setup --project /srv/my-project \
  --connection-settings /srv/private/container-settings.json --yes --json

# 从之后由用户主动启动的 serve 进程环境投影连接，不是捕获 setup 的环境
sandcastle-orchestrator setup --project /srv/my-project --connection-environment --yes
```

`--reuse-local-claude` 记录 `$CLAUDE_CONFIG_DIR/settings.json`，未设置时为 `~/.claude/settings.json`。`--yes` 仅确认新建文件，不能替代来源选择。setup 本身不读取任何连接内容，输出模型为 `inherit` 或显式 `--model` 的后端名称，不冒充已解析实际模型。

连接白名单、认证冲突、unsupported helpers 和模型继承全部复用 [#80 连接投影](connection-projection.md)。不新增认证方式，不强制另取 API key 或登录；宿主 `/login` 凭据复制/共享挂载不是受支持的迁移方式。生成资源只保存来源路径和非敏感选项。容器及获授权 Docker 管理者可能看到运行时认证，不能据此宣称完全隔离凭据。

当前没有 localhost 自动桥。连接必须使用容器可达 endpoint，`localhost` 和 `127.0.0.1` 指容器自身，host-gateway 名称也不会转发宿主 loopback。不修改代理 listener，不暗示 #81 已交付。

## 资源、冲突与手工合并

默认布局为 `~/.sandcastle-orchestrator/projects/PROJECT/`，包含 `config/config.mts`、同目录 `Dockerfile`、独立 `data/` 和 `input.json`。repo ID 来自项目名，role 为 `PROJECT-question`。`.mts` 配置明确使用 ESM，不创建或改写现有 package.json。

名称或文件冲突时换 `--name`，或显式指定全新的 `--config`、`--data`、`--input-path`。已有文件、符号链接、data 目录均不覆盖，reference-only 允许选现有 data 但不写入，`--yes` 不绕过物理路径和包含关系保护。资源不得位于安装目录、目标项目、Git metadata 或默认 demo 目录内，也不能反过来包含它们。不自动删除失败留下的文件。

已有自定义部署可用 `--reference-only --config /srv/new-reference/config.mts --data /actual/existing-data`，只生成新参考配置、输入和镜像配方供手工合并，不读取或重写已有配置，也不创建或修改 data。此时必须先把 repo/role/provider/environment/binding 合并进自己的可信配置，再调整输出中的 serve 配置路径；submit 仍须显式指定目标和 source。

生成配置通过当前安装的公开 `index.js` 的绝对 file URL 导入 `claudeCode`，不依赖全局包解析或内部深层导出。移动安装位置后须手动更新 import；常规同 prefix 换版本保留路径。可信配置加载会执行代码，不能把 serve/doctor 的配置检查说成纯静态无副作用。配置、data、输入和历史不随程序卸载删除。

## 镜像准备

推荐本地镜像标签 `sandcastle-orchestrator-claude:2.1.296`，容器 CLI 固定为原版 Claude Code `2.1.296`，与 [#80 已记录的 Docker 受控验收](issue-80-docker-acceptance.md) 使用同一 CLI 版本。没有可直接拉取的项目官方镜像。setup 在配置旁生成以下 Dockerfile，并输出带实际路径的准备命令。用户自行审阅后执行：

```dockerfile
FROM node:24.21.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code@2.1.296
```

用户主动准备及检查，可能联网下载依赖，但不调用模型。使用 stdin Dockerfile，不把现有配置目录作为 build context 发送给 daemon：

```sh
docker build -t sandcastle-orchestrator-claude:2.1.296 - < /actual/config/Dockerfile
docker image inspect sandcastle-orchestrator-claude:2.1.296
docker run --rm --pull=never --network none --entrypoint claude \
  sandcastle-orchestrator-claude:2.1.296 --version
```

可用 `setup --image YOUR_IMAGE`。基础标签及 apt 包并非按 digest 锁定；要严格复现应记录实际镜像 ID。setup 不检查 daemon/镜像，不自动安装或拉取，输出会给准备指引；runner 用 `--pull=never`，镜像不存在则执行失败并保留证据。

本票只验证生成配置可加载和受控执行，未构建或运行上面的推荐镜像，不能把 #80 的历史本地镜像 ID 当作此 Dockerfile 的产物证据。实际 Docker 与真实连接/模型仍须另行授权验收，不能据 setup 成功认定镜像或认证可用。

## 主动执行和读取报告

setup 输出带实际配置/data/输入路径、repo/role/source 的完整命令。在两个终端分别主动执行输出的 `serve` 和 `submit`。普通 submit 保持异步，不自动启动服务，也不从 cwd 推测目标。没有显式 `--model` 时省略 harness 的 model 参数，继承所选连接；显式覆盖只传用户给定名称。

生成 role 使用既有 runner 的默认 readonly workspace。仓库和 Git metadata 挂载只读，role 的 orchestrator tools/skills 为空，配置没有测试 capability、编辑、发布工具或发布凭据。harness 原生工具包括 shell，容器临时目录可写；这不是无 shell、全文件不可写或禁止一切远端写入的沙箱。问题和仓库内容作为待分析材料，不是扩大权限的授权。

提交回执取得真实 execution ID 后，使用输出的 data 路径：

```sh
sandcastle-orchestrator show EXECUTION_ID --data /actual/project/data --human
sandcastle-orchestrator logs EXECUTION_ID --data /actual/project/data --human
```

`show --human` 展示可读业务报告，完整原文另存 attempt 的 `artifacts/report.txt`。报告校验拒绝空白文本，只说明文本契约有效，仍需人工核对答案与固定 SHA。`completed`、exit 0、`contract: valid` 或任意 `passed` 字段均不表示测试通过。未知结束、停止及丢回执继续使用现有核对/人工恢复规则，不盲目重发。

## 本增量验收范围

- `tests/setup.test.ts` 通过 CLI 子进程、临时 Git 仓库、伪终端与既有 socket 验证 Git 固定版本、交互/非交互、来源明确选择、路径冲突、参考文件、秘密不复制；用受控 Docker adapter 驱动既有 role/provider 并读取本地报告。
- `tests/package.test.ts` 从源码之外安装 tgz，运行正式 setup，加载生成的外部 ESM 配置并通过文件提交。暂停 execution starts，只验证消费组合，不读取真实连接或启动 Docker。
- 未读取私人连接、运行真实 Docker/模型、产生模型费用或发布包。受控报告不是模型答案质量或真实 provider 验收。#80 历史 Docker 对受控 endpoint 的证据保持独立。

# setup：真实项目入口参考

首次使用请按[主教程](user-guide.md)操作，本页是参数和安全参考。0.1.0 已发布，安装后直接使用正式命令，不需要源码或 pnpm。setup 只生成入口，不启动服务、提交任务、运行 Docker、读取连接或调用模型。

```sh
sandcastle-orchestrator setup --project /srv/my-project
# 也可在项目任意子目录中运行 setup
```

交互时选择连接来源、资源名称和问题，看到项目根目录、完整 HEAD SHA、实际路径及摘要后确认。默认问题为“说明这个项目的主要模块及调用关系”。未提交内容只提醒，不包括在固定版本分析中。不会 clone、fetch、commit、切分支或加载项目内 TS 配置；Git 读取关闭 fsmonitor、hooks 和宿主全局配置。

## 参数速查

| 参数 | 用途 |
| --- | --- |
| `--name NAME` | 新资源名，1–64 位小写字母、数字、连字符或下划线，首位为字母或数字 |
| `--question TEXT` | 固定版本上的非空问题 |
| `--model NAME` | 显式客户端模型名，默认继承 |
| `--image IMAGE` | 已有可信 Agent 镜像 |
| `--config FILE` / `--data DIR` / `--input-path FILE` | 指定互相独立的新资源路径 |
| `--non-interactive` | 即使在终端中也禁止询问 |
| `--yes` | 确认创建，不跳过授权或冲突保护 |
| `--json` | stdout 仅输出结果，诊断在 stderr |

自定义 `--image` 保留镜像配置，但生成配方和 prepareImage 命令仍只构建推荐标签。自定义镜像须自行准备 POSIX sh、env、Git、Node.js 和兼容的原版 Claude Code；只有 Node 的 demo 镜像不适用。

## 连接选择

先考虑复用本机已授权的静态连接。`--reuse-local-claude` 只引用 settings，不迁移 `/login` OAuth/订阅登录、helper 或 CC-Switch 数据库。宿主能运行不代表容器可用。没有受支持的现成连接时，按[主教程](user-guide.md#2-准备模型连接)准备独立 settings，确认 endpoint、认证、模型名、数据授权和费用。

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

连接白名单、认证冲突、unsupported helpers 和模型继承全部复用 [连接投影](connection-projection.md)。不新增认证方式，不强制另取 API key 或登录；宿主 `/login` 凭据复制/共享挂载不是受支持的迁移方式。生成资源只保存来源路径和非敏感选项。容器及获授权 Docker 管理者可能看到运行时认证，不能据此宣称完全隔离凭据。

执行级 HTTP loopback 桥仅支持可核实的本机 Linux rootful Docker bridge；HTTPS loopback、远程/rootless Docker 等须使用容器可达 endpoint，限制见 [连接投影与执行桥](connection-projection.md)。setup 不探测桥、endpoint 或认证；生成成功不代表连接可用。

## 资源、冲突与手工合并

默认布局为 `~/.sandcastle-orchestrator/projects/PROJECT/`，包含 `config/config.mts`、同目录 `Dockerfile`、独立 `data/` 和 `input.json`。repo ID 来自项目名，role 为 `PROJECT-question`。`.mts` 配置明确使用 ESM，不创建或改写现有 package.json。

名称或文件冲突时换 `--name`，或显式指定全新的 `--config`、`--data`、`--input-path`。已有文件、符号链接、data 目录均不覆盖，reference-only 允许选现有 data 但不写入，`--yes` 不绕过物理路径和包含关系保护。资源不得位于安装目录、目标项目、Git metadata 或默认 demo 目录内，也不能反过来包含它们。物理路径祖先存在 `.git` 或 `init.json` 时也拒绝，保护自定义 demo 仓库/data；不加载其中的配置或标记。不自动删除失败留下的文件。

已有自定义部署可用 `--reference-only --config /srv/new-reference/config.mts --data /actual/existing-data`，只生成新参考配置、输入和镜像配方供手工合并，不读取或重写已有配置，也不创建或修改 data。此时必须先把 repo/role/provider/environment/binding 合并进自己的可信配置，再调整输出中的 serve 配置路径；submit 仍须显式指定目标和 source。

生成配置通过当前安装的公开 `index.js` 的绝对 file URL 导入 `claudeCode`，不依赖全局包解析或内部深层导出。移动安装位置后须手动更新 import；常规同 prefix 换版本保留路径。可信配置加载会执行代码，不能把 serve/doctor 的配置检查说成纯静态无副作用。配置、data、输入和历史不随程序卸载删除。

## 镜像准备

推荐本地镜像标签 `sandcastle-orchestrator-claude:2.1.296`，容器 CLI 固定为原版 Claude Code `2.1.296`。没有可直接拉取的项目官方镜像。setup 在配置旁生成以下 Dockerfile，并输出带实际路径的准备命令。用户自行审阅后执行：

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

构建失败时先修复可信下载途径。daemon 的 localhost 代理不等于 RUN 步骤可用代理，不要为下载开放私人代理到全网或关闭 TLS。

## 主动执行和读取报告

setup 输出带实际配置/data/输入路径、repo/role/source 的完整命令。在两个终端分别主动执行输出的 `serve` 和 `submit`。普通 submit 保持异步，不自动启动服务，也不从 cwd 推测目标。没有显式 `--model` 时省略 harness 的 model 参数，继承所选连接；显式覆盖只传用户给定名称。

生成 role 使用既有 runner 的默认 readonly workspace。仓库和 Git metadata 挂载只读，role 的 orchestrator tools/skills 为空，配置没有测试 capability、编辑、发布工具或发布凭据。harness 原生工具包括 shell，容器临时目录可写；这不是无 shell、全文件不可写或禁止一切远端写入的沙箱。问题和仓库内容作为待分析材料，不是扩大权限的授权。

提交回执取得真实 execution ID 后，使用输出的 data 路径：

```sh
sandcastle-orchestrator show EXECUTION_ID --data /actual/project/data --human
sandcastle-orchestrator logs EXECUTION_ID --data /actual/project/data --human
```

`show --human` 展示可读业务报告，完整原文另存 attempt 的 `artifacts/report.txt`。报告校验拒绝空白文本，只说明文本契约有效，仍需人工核对答案与固定 SHA。`completed`、exit 0、`contract: valid` 或任意 `passed` 字段均不表示测试通过。未知结束、停止及丢回执继续使用现有核对/人工恢复规则，不盲目重发。

## 验证边界

setup 成功只代表资源已生成。它不验证模型认证、可达性、计费或答案质量。历史指定环境证据分别见[受控容器验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-82-container-acceptance.md)与[真实模型验收](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/issue-85-real-acceptance.md)，不能替代你所选连接的验证。本次文档重写未运行 Docker、读取私人连接或调用真实 provider。

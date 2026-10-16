# 正式发布操作

本流程对应 [#86](https://github.com/canxer314/sandcastle-orchestrator/issues/86)。0.1.0 已完成发布和渠道验证，结果见[发布验收](issue-86-release-acceptance.md)；准备与失败历史见[核对记录](issue-86-release-preparation.md)。下文保留本次流程供维护者核对，不可重新发布已存在的 0.1.0。以下远端写入命令仅供后续版本在另获授权、账号与权限核实后参考。仓库提交、issue 标签和 registry 404 都不是发布授权。

## 固定候选与版本

本次发布的是 `@canxer314/sandcastle-orchestrator@0.1.0`，命令为 `sandcastle-orchestrator`，不接管依赖的 `sandcastle`。唯一候选是 #85 指南补验归档的 `canxer314-sandcastle-orchestrator-0.1.0.tgz`：

```sh
ARTIFACT=/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-85-guide-0aebada/canxer314-sandcastle-orchestrator-0.1.0.tgz
printf '%s  %s\n' 057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562 "$ARTIFACT" | sha256sum --check
```

异机先复制原件，再设置其实际绝对路径并核对相同哈希。不要用重新打包的产物替换它。#85 的[受控验收](issue-85-candidate-acceptance.md)、[真实验收](issue-85-real-acceptance.md)与[指南补验](issue-85-guide-acceptance.md)共同构成验收依据；unknown 不算已确认停止，受控模型/容器不算真实渠道验收。

这是首个稳定版本，当前 package.json 已为 `0.1.0`。逐项核对 `.changeset/` 的既有功能记录；发布准备阶段仅增加不入包的发布文档，没有新增公共行为，不新增版本 bump。发布后线上指南更新另有 `issue-86-published-guides.md` changeset，供未来包版本使用，不改变已发布的 0.1.0。仓库没有 Changesets CLI/config，不临时运行未配置的批量升版。发布前若版本被占用、需要改版本或包内文件，必须先作出版本决定、重建候选并补齐受影响的验收与哈希，不能把新包冒充本候选。预发布版本只能使用独立 tag，不能进入 `latest`。

## 账号、授权与远端发布

取得针对该包、版本、哈希、npm public/latest、GitHub Release 和发布后隔离 Docker 验证的明确授权。核实实际 npm 登录账号、`canxer314` scope 归属或授权、精确包名和发布凭据的 public 写权限。使用现有登录或维护者配置的最小权限凭据，不导出 token，不创建或扩大凭据。

```sh
npm whoami --registry=https://registry.npmjs.org
npm access list packages --json --registry=https://registry.npmjs.org
npm view @canxer314/sandcastle-orchestrator versions dist-tags --json --registry=https://registry.npmjs.org
gh release list --repo canxer314/sandcastle-orchestrator
```

首次发布前，包可能没有 ACL 条目；查不到包不证明 scope 可写。维护者须在 npm 账号/scope 与凭据权限中核实，未确认就停下。登录成功和 `--dry-run` 也不能独自证明远端发布权限。

发布说明见[0.1.0 说明](release-0.1.0.md)。核对候选来源后，本版本 tag 指向已验收代码的主线提交 `a01d0d1dd3b3c4704ebd7b5493ffa03759d301e7`。如果 tag 已存在，先核对其目标及附件，不覆盖或盲目重试。以下保留当时获准后的发布命令。0.1.0 已存在，不可再次执行：

```sh
set -eu
printf '%s  %s\n' 057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562 "$ARTIFACT" | sha256sum --check
npm publish "$ARTIFACT" --access public --tag latest --registry=https://registry.npmjs.org
gh release create v0.1.0 "$ARTIFACT" \
  --repo canxer314/sandcastle-orchestrator \
  --target a01d0d1dd3b3c4704ebd7b5493ffa03759d301e7 \
  --title 'Sandcastle orchestrator 0.1.0' \
  --notes-file docs/release-0.1.0.md
```

首次 Release 正文明示待验证，正式渠道验证后才记录真实结果、移除草案标记并切换首页。两处上传都使用上面的原始 tgz；不使用自动生成的源码 zip/tar.gz，不维护第二套安装器。

任一发布命令失败、超时或回执不明，保存输出，先读回 npm 版本及 Release/tag/附件现状。npm 成功而 Release 失败属于部分发布，README 保持原入口；不能盲目重发、撤包、删 tag 或删 Release。任何删除需要另行授权。

## 发布后核对

在源码目录外，为 npm 和 Release 各建新的私有验证目录、HOME、prefix、cwd，所有路径与用户资源分开。保存命令、退出码、stdout/stderr、环境版本和产物哈希。不要把日志中的私人路径或凭据上传到公开 Release。

先读回 `npm view @canxer314/sandcastle-orchestrator@0.1.0 dist --json` 和 `npm view @canxer314/sandcastle-orchestrator dist-tags --json`，保存真实 tarball URL、integrity 及 `latest`。从该 URL 下载 npm 原件，核对 SHA-256 为上述候选哈希，并核对 SHA-512 SRI 与 `dist.integrity`。再用 `gh release view v0.1.0 --repo canxer314/sandcastle-orchestrator --json url,tagName,assets` 记录真实 Release URL、附件名和 URL。下载该 tgz，核对相同 SHA-256。不能以解包后文件相同代替两渠道 tgz 字节一致。

分别从正式 npm 固定版和 Release 附件安装。下面的 `PREFIX`、`HOME` 和当前目录由验证者设置为本轮新目录；不能复用日常安装位置。生产依赖可能联网下载。

```sh
# npm 验证环境
npm install --global --prefix "$PREFIX" --registry=https://registry.npmjs.org @canxer314/sandcastle-orchestrator@0.1.0
"$PREFIX/bin/sandcastle-orchestrator" --version
"$PREFIX/bin/sandcastle-orchestrator" --help
# 另一个全新环境，先下载真实 Release 附件
gh release download v0.1.0 --repo canxer314/sandcastle-orchestrator \
  --pattern canxer314-sandcastle-orchestrator-0.1.0.tgz
npm install --global --prefix "$PREFIX" ./canxer314-sandcastle-orchestrator-0.1.0.tgz
"$PREFIX/bin/sandcastle-orchestrator" --version
```

另用一个全新 npm prefix 验证不带版本的安装入口，并断言返回 `0.1.0`，不能仅检查 registry 的 latest。安装后 PATH 只选择本次 prefix；不得偶然调用源码入口或已有全局程序。

在获准 Linux/Docker 环境分别用两渠道安装的 CLI 执行 `init`、`doctor`、`demo`。记录 Linux/Node/Git/flock/Docker/镜像版本，所选配置与 data，实际执行编号及 SHA。首次体验不需要模型账号，不读取私人连接。使用独立的缺依赖环境核对 doctor 的修复指引，不破坏主机依赖或删除镜像；安装依赖、启动 Docker、拉镜像必须在授权范围内。

demo 验证必须分别保存测试结果、执行停止、本次服务退出、控制服务日志和 attempt 日志。独立检查实际容器已停止与本次服务 PID 已退出；不要只凭 `completed`、socket 消失或 exit 0 推断全部通过。unknown 或失败保留现场，按[demo 排障](demo.md#证据与排障)核对，不自动重跑。程序安装与文档更新本身不得加载用户配置、启动/重启用户服务、迁移数据、清理资源或修改 harness/CC-Switch。

## 首页切换与交付

正式 npm、Release 同一产物和上述快速开始全部通过后，才更新 README 首页，保留 README 后续维护、高级能力及用户已有修改。同步检查 installation、onboarding、demo、user-guide、deployment-guide 的当前状态描述；历史报告保留当时结论，增加指向最终发布记录的说明，不篡改历史。

已发布 tgz 内 README 是候选验收时的旧入口，不能为更新首页重新打包或覆盖同版本。Release 页面应指出这一点，并链接已核验的线上快速开始。后续文档入包按正常新版本重新验收。

最终记录实际 npm/Release URL、版本、tag 目标、附件、两个渠道哈希、独立安装环境、测试/停止/日志证据及限制；未运行项明确保留。提交前检查 README、相关指南、changeset，运行 typecheck、安装/CLI/socket 回归和全套。#86 在正式发布完成前保持未完成，不自动关闭或改写父票 #65。

# 开发与发布

## 本地开发

使用 Linux、Node.js 24+ 和 pnpm 12.3.4。在源码 checkout 中运行：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec vitest run tests/package.test.ts tests/human.test.ts tests/management.test.ts --maxWorkers=1
pnpm exec vitest run --maxWorkers=1
pnpm run build
```

实现期间运行相关 CLI/socket 测试，提交前运行全套。真实模型调用、Docker 执行、外部写入和发布各自需要明确授权，受控 adapter 测试不能替代真实验收。开发入口是 `pnpm start`，用户安装后的入口是 `sandcastle-orchestrator`。

保持 CLI/socket 的验收入口。业务判断属于角色和能力，不放进调度器。改变公开行为时添加 patch 或合适级别的 changeset，检查 README 与五篇任务指南。修改配置、持久化记录或管理协议前先确认兼容范围，保留现有迁移、人工核对和恢复机制。配置部署版本、初始化布局与数据库结构不是同一个版本。

固定依赖和锁文件一起审查。仓库有 `.changeset/` 记录，但没有配置 Changesets CLI；不要临时运行批量升版工具。

## 准备一个发布候选

1. 明确版本和目标主线 commit，检查已有 changeset 与包内文件清单。已发布版本不可覆盖，预发布必须使用独立 dist-tag，不能进入 `latest`。
2. 完成 typecheck、相关 CLI/socket/package/management 测试及全套测试。用 `pnpm pack` 生成唯一候选 tgz，记录文件名、源 commit、SHA-256 和 SHA-512 SRI。需要修改版本或包内文件时重新构建并补验，不能把新字节冒充旧候选。
3. 在源码树外的新私有目录，以独立 HOME、prefix、cwd 安装该 tgz。核对版本、帮助、包外配置、五篇指南及链接、资源保留和换版。测试中不得意外调用已有全局 CLI。
4. 只有获得独立授权后，才做真实 Docker、模型或发布渠道验收。记录实际环境、执行编号、固定 SHA、日志与停止证据；unknown 不能算通过。不得把私人连接、token 或原始敏感日志带进发布附件。

## 核实账号与发布授权

发布前取得针对包名、版本、候选哈希、npm public/dist-tag、GitHub tag/Release 及发布后验证的明确授权。核实 npm 登录账号、scope 归属或授权、精确包名和最小权限发布凭据。不导出 token，不临时创建或扩大凭据。

以下命令供获准的维护窗口使用，不是日常开发步骤：

```sh
npm whoami --registry=https://registry.npmjs.org
npm access list packages --json --registry=https://registry.npmjs.org
npm view @canxer314/sandcastle-orchestrator versions dist-tags --json --registry=https://registry.npmjs.org
gh release list --repo canxer314/sandcastle-orchestrator
```

首次发布时，包可能没有 ACL 条目；404、登录成功或 `--dry-run` 都不证明 scope 可写。权限、2FA 或组织要求不满足时停下，不能关闭安全机制绕过。

## 发布同一份 tgz

由维护者设置实际的 `ARTIFACT`、`SHA256`、`VERSION`、`TARGET_COMMIT` 和 `NOTES`。`NOTES` 是本轮经审查的说明文件，说明支持平台、依赖、安装方式、权限与费用、兼容和恢复边界及未验证项，不在用户指南中保留旧版本流水账。确认版本和 tag 未被占用，已有 tag 则先核对目标与附件，不覆盖。

```sh
set -eu
printf '%s  %s\n' "$SHA256" "$ARTIFACT" | sha256sum --check
npm publish "$ARTIFACT" --access public --tag latest --registry=https://registry.npmjs.org
gh release create "v$VERSION" "$ARTIFACT" \
  --repo canxer314/sandcastle-orchestrator --target "$TARGET_COMMIT" \
  --title "Sandcastle orchestrator $VERSION" --notes-file "$NOTES"
```

预发布须把 `latest` 换成事先批准的独立 tag。npm 与 Release 上传同一个原始 tgz，不使用 GitHub 自动生成的源码归档，不维护第二套安装器。

失败、超时或回执不明时保存输出，先读回 npm 版本与 Release/tag/附件现状。npm 成功而 Release 失败是部分发布，不能盲目重发、撤包、删除 tag 或 Release；删除需要另行授权。

## 验证正式渠道再更新首页

读回固定版本的 `dist` 与 dist-tags，记录实际 tarball URL、integrity 和 tag。下载 npm 原件，核对候选 SHA-256 和 `dist.integrity`。再读回 Release 的 tag 目标、URL、附件名与下载 URL，下载 tgz 并核对相同哈希。不能只比较解包后的文件。

为 npm 固定版、无版本安装入口和 Release 附件分别新建私有 HOME、prefix、cwd。安装会下载依赖，须在授权范围内。断言三者版本正确、PATH 只选本次 prefix、帮助和包内文档可用。

在获准的 Linux/Docker 环境，用两渠道安装的 CLI 按[安装与演示](docs/installation.md)执行 init、doctor、demo。记录 Linux/Node/Git/flock/Docker/镜像版本，实际配置和 data、执行编号及 SHA。分别核对测试结果、实际执行停止、本次服务进程退出、控制服务与 attempt 日志。`completed`、socket 消失或 exit 0 都不足以独立证明全部停止。unknown 保留现场，按[查询与恢复](docs/queries.md)核对，不自动重跑。

缺依赖指引在隔离环境验证，不破坏主机依赖、不删除镜像。安装和文档更新不得加载用户配置、启动或重启用户服务、迁移数据、清理资源或修改 harness/CC-Switch。

正式 npm、Release 字节一致和快速开始全部通过后，才更新 README 与五篇指南。已发布 tgz 内的文档不能为更新首页而重打包覆盖；后续文档按新版本重新验收。交付时记录真实渠道、版本、tag 目标、哈希、环境、测试和停止证据及未验证项。历史证据留在 Git 历史，不复制进用户文档。

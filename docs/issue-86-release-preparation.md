# #86 发布准备核对

本轮基于 `origin/master` 的 `a01d0d1dd3b3c4704ebd7b5493ffa03759d301e7`，在独立 worktree `/home/canxer/repos/sandcastle-issue-86-master`、分支 `issue-86-release-from-master` 工作。原有 `sandcastle-issue-86` worktree 与当前用户工作区未修改。

本节保留授权前的准备阶段结论；最终发布结果见[正式验收](issue-86-release-acceptance.md)。当时结论是发布准备可交付，#86 尚未完成。没有发布 npm、创建 tag/Release、推送代码、切换 README 或改变父票 #65。后续按[发布操作](release.md)执行，已准备[固定版本 Release 说明](release-0.1.0.md)与首页草案，后者已在正式验收后应用到 README。

## 候选与依赖证据

[#85 最终合入记录](https://github.com/canxer314/sandcastle-orchestrator/issues/85#issuecomment-6222721359)与主线包含的三份报告已核对：

- [候选消费与受控回归](issue-85-candidate-acceptance.md)覆盖包外安装、CLI/socket 与组合测试。
- [真实 Docker/模型/代理](issue-85-real-acceptance.md)分别记录真实 demo 成功/失败、固定 HEAD、日志、中断、真实只读问答与连接切换。
- [指南补验](issue-85-guide-acceptance.md)补齐人工备份/恢复命令，第 14 项现有证据，不沿用早期缺验结论。

#85 的 16/16 是候选验收结论，不是本轮渠道通过。双中断返回 unknown、lost-no-match 缺独立执行停止证据等原始限制保留，不计为安全停止通过；受控恢复、混合故障与真实正常路径仍分别说明。未覆盖任意历史版本兼容、所有镜像/后端组合或真实供应商故障，不扩大既有结论。

本次选定原件为 `/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-85-guide-0aebada/canxer314-sandcastle-orchestrator-0.1.0.tgz`，SHA-256：

```text
057d4c715d7ed3a71af698f7b69935044159cf193760d76ca4cbc399e8440562
```

已逐个核对原归档 `sha256.json` 中 tgz、metadata.json、evidence.tar.gz 的哈希，全部匹配。当前主线用 `npm pack` 重建，tgz 哈希也完全相同；89 个文件的名称、内容与 mode 均相同。新发布文档不在 package.json 的 files 列表，不修改候选内容。

第一次用 `pnpm pack` 比较失败，保留原结果：哈希为 `14b1c7ab48278c4a8f023d6e41a950540311b0da7af5e331b84cf503fe9cc5c9`，唯一文件差异为 package.json，pnpm 规范化 repository、移除 packageManager/prepack 并改变排版。随后改用 #85 测试实际使用的 `npm pack` 证明重现；没有把 pnpm 重建包作为发布原件。

版本检查确认名称为 `@canxer314/sandcastle-orchestrator`，版本 `0.1.0`，public 发布配置，唯一 bin 为 `sandcastle-orchestrator`，Node 要求 >=24，无 install/uninstall 生命周期脚本。已检查既有 changeset，旧条目仍使用历史非 scope 名称，新安装/CLI/连接/维护/指南条目使用正式 scope 名称。它们是既有功能记录，当前没有 Changesets CLI/config；本轮没有公共行为改动，不额外 bump 或批量改写历史条目。首版拟使用已验收的 0.1.0，若维护者选择其他版本必须重新生成、验收候选，不能只改发布命令。

## 本轮只读渠道检查

检查发生于 2026-10-17 Asia/Shanghai，UTC 为 2026-10-16：

- `npm whoami --registry=https://registry.npmjs.org` 返回 `ENEEDAUTH`。实际 npm 账号、scope 归属/授权和 public 写权限未核实。没有运行 npm login、读取 token 或扩大凭据。
- `npm view @canxer314/sandcastle-orchestrator version dist-tags --json --registry=https://registry.npmjs.org` 返回 E404。这不证明名称可注册或账号可发布。
- `gh release list --repo canxer314/sandcastle-orchestrator` 未列出 Release；`gh release view v0.1.0` 返回 `release not found`。
- `git ls-remote --tags origin refs/tags/v0.1.0` 没有匹配。GitHub 读取权限不代表已验证 Release 写权限。

本次请求授权了独立 worktree 实现，未明确授权 npm/Release 写入及发布后真实 Docker 验证。#86 明确要求另获本次发布授权。因此在账号/权限、发布授权和获准真实验证环境齐备前，不执行远端写入。

## 本轮验证

环境为 Linux x86_64、Node v24.21.0、npm 12.0.2、pnpm 12.3.4。常规测试只用既有受控适配器，本轮未启动真实 Docker 或读取私人模型连接。

归档原件在源码外 `/tmp/issue-86-release-preparation` 的独立 HOME、prefix、cwd 中实际安装。安装生产依赖允许联网，不借用开发 node_modules，不承诺离线。正式命令的 `--version` 输出 `0.1.0`，`--help` 成功；这只是本地候选安装，不是 npm 正式入口或 Release 下载验收。

- `pnpm install --frozen-lockfile` 成功。
- `pnpm run typecheck` 通过。
- `pnpm exec vitest run tests/package.test.ts tests/management.test.ts tests/human.test.ts tests/writes.test.ts --maxWorkers=2`：4 文件、152 测试通过，74.22 秒。包消费测试自行构建相同产品代码；另行核对原件安装如上。
- `pnpm test --maxWorkers=2`：21 文件通过、2 文件跳过，401 测试通过、22 跳过，235.09 秒。跳过项不算本轮真实验收。
- 4 份新增文档的本地链接与 8 段 shell 语法检查通过。最终打包哈希仍与候选相同；README、package.json、锁文件及既有 changeset 无改动。
- code-review 双路复核完成：Standards 为 0 项规范违反、0 项 smell；Spec 为 0 项实质发现。复核确认本轮符合缺少授权/权限时的发布准备范围，不表示正式发布完成。

原始记录位于 `/tmp/issue-86-release-preparation/`：`typecheck.log`、`targeted.log`、`full.log`、`artifact-comparison.json`、`npm-artifact-comparison.json`、`candidate-smoke.json`、两次打包记录和重建 tgz。首次比较失败不隐去。持久归档位于 `/home/canxer/.local/state/sandcastle-orchestrator-acceptance/issue-86-release-a01d0d1/`，根目录权限 0700，包含上述验证日志、原归档校验结果、最终同哈希 tgz、metadata.json 及逐文件 sha256.json，不包含安装依赖目录或私人凭据。

## 未完成项

正式 npm/Release 链接尚不存在可验证记录，两个远端渠道下载与哈希、正式固定版本及 latest 独立安装、正式产物 init/doctor/依赖修复/真实 demo 均未运行。README 首页及现有安装指南保持候选阶段状态；草案不作为已发布入口。

初次准备结束时，下一步为取得发布授权和核实 npm 权限。后续进展见下节；发布失败保留证据，不自行撤包或删除 Release。

## 授权后复查

用户随后明确回复“继续，我给你授权”。本次 `0.1.0` 同哈希候选的 npm public/latest、GitHub Release 发布及独立环境真实 Docker 快速开始验证已获授权，不再将缺少发布许可列为阻塞。

2026-10-17 03:19 Asia/Shanghai 复查：`npm whoami` 和 `npm access list packages` 仍返回 ENEEDAUTH，包查询仍为 E404；实际 npm 身份与 scope/public 写权限仍未核实。已请用户在本机终端完成 npm 登录，不在聊天中传递凭据。

GitHub API 返回该仓库 push/maintain/admin 权限为 true，`v0.1.0` tag/Release 仍不存在。Docker client/server 均为 29.8.1，演示镜像 `node:22.22-alpine` 已存在，ID 为 `sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd`；Git 2.53.0 与 `/usr/bin/flock` 可用。候选原件 SHA-256 再次匹配。

当前唯一已知阻塞是 npm 登录及发布权限核实。尚未执行远端写入、正式渠道安装或真实 demo，README 保持原样。登录完成后沿用本次授权继续发布与验证，不重复请求发布许可。

## 登录后发布尝试

2026-10-17 03:28 Asia/Shanghai，用户完成登录，`npm whoami` 确认 `canxer314`，与个人 scope 一致；包 ACL 列表为空，首次包查询仍 E404。候选哈希再核对通过后，按本次授权执行对原始 tgz 的 `npm publish --access public --tag latest --registry=https://registry.npmjs.org --no-browser`。

npm 返回 E403，说明发布要求双重验证或允许 bypass 2FA 的 granular token。随后的账号查询仅记录 name/tfa，结果为 `canxer314` / `false`；未输出或保存凭据。读回 `@canxer314/sandcastle-orchestrator@0.1.0` 仍 E404，未宣称发布成功，也未盲目重试。GitHub Release 尚未创建，首页尚未切换。

当前阻塞更新为 npm 账号未启用 2FA，登录问题已解决。需要用户在 npm 官网完成账号双重验证设置；不由代理创建或扩大 token 权限。后续仍沿用既有发布授权。脱敏账号状态与发布后读回结果保存在 `/tmp/issue-86-published/`。

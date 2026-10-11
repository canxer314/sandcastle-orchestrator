# Issue #19：真实只读角色验收（2026-10-11）

## 范围与授权

用户授权当前主机启动测试容器，通过现有 CC-Switch 路由使用已登录的 Codex 账户完成只读角色验收。没有授权 GitHub 写入；没有修改 CC-Switch 配置或复制 OAuth 登录文件。

这是 Claude Code CLI → 本地 CC-Switch → Codex OAuth 的真实 provider 路径，不是 Anthropic 直连验收，也不证明 #20 的并发调度。

## 环境

- 应用基线：`558a041`，Sandcastle `0.12.0`，Effect `3.20.0`。
- Docker Engine `29.8.1`；专用镜像安装 Claude Code `2.1.296`、Git 和 CA certificates，实际运行镜像 ID 为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。
- 镜像从 `node:24-bookworm-slim` 构建，未加入宿主 home、CC-Switch 数据库或目标业务仓库。
- 专用内部网络 `issue-19-acceptance`：`10.231.19.0/28`。临时 TCP relay 只监听 `10.231.19.1:15721`，只接受该网段容器连接，只转发到宿主 `127.0.0.1:15721`。无 host network、无公网监听。
- 仅临时无敏感 repo：`context.txt` 写明 project name 为 `lighthouse`，完整 SHA `961cfddb7f83e1810219cc6ffd7b9a0f6d08bbe1`。
- 环境在内存中读取宿主已有代理认证与模型映射；凭据值未写入验收配置或本文。Docker environment 中有代理认证，故不得发布未经筛选的 inspect 输出。

## 首次运行与发现

通过公开 CLI/socket `submit` 提交 `fixture/report`，输入 `inspect`。

- Execution：`e09b907a-4ebc-49be-bd12-c4e12d670bfd`。
- Attempt：`25f534e6-10aa-40e0-8d88-8af5e273a817`。
- 专用 branch：`orch/25f534e6-10aa-40e0-8d88-8af5e273a817`。
- 模型实际 Read 工具读取文件，返回 `The project name is lighthouse.`。
- Session：`804ad124-9d39-4157-9628-72fd49b81494`。
- 原始日志退出证据：`ORCH_EXIT_4d1431c77b80fc0b3e22f9f72fdd20e8b1fc2042a1a355e4:0`。
- `show` 保存 `exitCode: 0`、`contract: valid`、业务报告与 session 引用，但同时记录 SDK 后处理错误。因此首次运行不能视为无错误验收。

设施证据不是模型自述：筛选后的 Docker inspect 证明代码、Git metadata、stop 目录均 `RW: false`，rootfs readonly，运行 UID/GID `1000:1000`。写入探针确认 workspace 和 `/etc` 不可写，隔离 home 与 `/tmp` 可写；容器内 Git 确认 branch 和 SHA。源 repo 无变化。退出后 `docker top` 仅剩待机 `sh`/`sleep`，没有活动 Claude CLI。

根因：session 位于 `/home/agent` tmpfs。`docker exec` 能读取实际 135459 字节 JSONL，而 `docker cp` 报找不到同一路径，导致 SDK session capture 失败。修复保留只读设施与公开文件导出契约，没有关闭 session capture 来掩盖错误。

## 证据位置与限制

本机原始证据位于 `/tmp/issue-19-acceptance/`；运行记录与日志位于独立的 `/tmp/issue-19-acceptance-data/`。原始 session 仅本机保存，不提交；临时目录不是长期归档保证。本文仅保存经过筛选的事实。

默认不限时通过实际运行的 `src/agent.ts` 参数 `Infinity / Infinity / []` 核对；短运行不证明无限时长。没有加入费用、token、turn 预算。此次无需任何首次登录初始化绕过配置；非交互 CLI 使用已有代理认证成功调用上游。

## 最终复验

修复后，通过公开 `retry` 提交人工核查记录，启动第二次真实尝试：

- Attempt `37361dff-9156-45a0-88c6-c4c156ebc1cc`，branch `orch/37361dff-9156-45a0-88c6-c4c156ebc1cc`，与首次运行不同的独立目录。
- SHA 仍为 `961cfddb7f83e1810219cc6ffd7b9a0f6d08bbe1`；原 attempt 逐字段未变。
- Session `19450e9b-bbcc-456e-90b4-a8a63472c95e`，与首次不同，JSONL 经公开 SDK 成功导出到独立数据目录，`sessionFilePath` 可读。
- 输出 `The project name is lighthouse.`；`exitCode: 0`、`contract: valid`、`logs.complete: true`，没有运行或 SDK 后处理 error。
- 原始日志退出证据 `ORCH_EXIT_c3a1c06e03ccfb66bac84145c44e9a6b3fd23032947e74a5:0`。
- 第二个容器仍保持 readonly 挂载、readonly rootfs 和 UID/GID `1000:1000`。退出后 `docker top` 只剩待机 `sh`/`sleep`。
- 结束后重启控制服务，公开 `show` 的两次 attempt 与重启前逐字段一致，`logs` 可查询，没有自动重跑。

本次通过了 #19 第 5、8、9 项所需的单角色真实运行检查，限于上述 CC-Switch/Codex 路径。没有验证其他 provider、真实协作取消响应或并发调度。未在 GitHub 修改清单或关闭 issue。

最终 `pnpm run typecheck` 通过；`pnpm test` 为 5 files、71 passed、20 skipped；20 项显式 Docker 测试未启用，不能算作通过。相关 Agent/roles 测试 13 passed，`git diff --check` 通过。

确认两个 Agent 均已退出后，人工停止两个待机验收容器、临时 relay 和控制服务。容器、专用内部网络和镜像保留，未删除本地证据。没有改动原 CC-Switch 监听或登录状态。

# Issue #21 真实配额验收

验收日期为 2026-10-11。应用代码固定为 `2e94d659e6961a8a7014353dbe162aed5945cfef`，在独立 worktree 执行，没有修改产品代码。三次真实 provider 调用验证正常排队、协作取消和可信结束后的名额释放。重启恢复使用独立的准备阶段控制服务，没有启动模型或容器，不应写成真实运行中崩溃恢复验收。

## 环境和输入

用户授权已有专用 Docker、非敏感 fixtures 和既有 CC-Switch 路由，没有新增登录、凭据、模型迁移或 GitHub 写入。初次创建临时 Git repo 的命令被 worktree isolation guard 拒绝，未绕过。用户随后提供两个已创建的 repo groups。本次只使用 `/tmp/issue-21-repos-ES4yky/{alpha,beta}`，第二组未读取或修改。

- alpha SHA `8f6d4b185dadf233e5ec4047d7ba922fd3a63fb8`，fixture 为 `Issue 21 acceptance fixture: alpha`。
- beta SHA `899b751eda555051f0e0cbe9fc4335667b7fc31d`，fixture 为 `Issue 21 acceptance fixture: beta`。
- 镜像 `issue-19-acceptance:2.1.296`。runner 核验 ID 为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。
- runner 核验内部网络 `issue-19-acceptance` 为 `true 10.231.19.0/28 10.231.19.1`。自己的 relay 仅监听 gateway `10.231.19.1:15721`，只接受该网段容器，转发已有 `127.0.0.1:15721`。
- 配置和原始证据 `/tmp/issue-21-real-LCffvD/`；主要数据 `/tmp/issue-21-data-Yv40bN/`；独立恢复数据 `/tmp/issue-21-restart-data-Vuqskk/`；session 在证据目录的 `sessions/`。不提交原始 logs、session、完整 Docker inspect 或认证 environment。
- provider 仍为 `claudeCode('opus', {effort:'low'})`。三个 run 的 CLI init 声明 `claude-opus-4-8[1M]`，实际 assistant 事件声明 `gpt-6.1-sol`。这是 Claude CLI、CC-Switch、Codex OAuth 路由验收，不是 Anthropic 直连，也不是上游费用证明。

角色 preparation 使用本地文件 gate。gate 只控制 prompt preparation，不替代 provider、Docker 或退出适配器。所有 submit/show/logs/cancel/confirm-stop 使用公开 CLI/socket。

## 排队、准备占额和 deterministic 工作

配置 global limit 为 2，两个 repo 都未设置 override，使用默认 repo limit 1。顺序提交 alpha1、alpha2、beta1、beta2。独立准备 receipt 只有 alpha1 和 beta1，公开状态依次为 `starting, queued, starting, queued`。alpha2 比 beta1 更早，但 alpha 满额没有阻塞 beta。alpha2 与 beta2 的 preparation 尚未执行。

双额满时 execution `c6b4f710-40fa-4ee6-a00d-710d42119406` 在真实 Docker 内读取 alpha fixture，容器 exit 0、execution completed。该首次 harness 返回 `{summary}` 而非 required `{business}`，因此 contract 为 error，不能算有效业务报告。

修正临时配置的返回格式后，另开两个仅 preparation 的 attempts 保持双额满，真实 Docker deterministic 再次完成。该 execution 为 `7364cc94-78e6-433a-897e-51111ff4ff46`，attempt 为 `58e9f56d-aa41-4314-bc41-dc252feee225`，actual SHA 为 alpha 输入 SHA。`valid-deterministic-while-full` 的状态为 `starting, starting, completed`，deterministic `exitCode:0`、`contract:valid`，business 精确为 fixture 内容。随后取消两个 preparation attempts，均 `never-started`，没有新增 provider 调用。真实 Docker 的 deterministic workspace mount 本身可写；本次命令仅为 `cat`，不把它描述成强制 readonly workspace。rootfs 是 readonly。

beta2 在队列中取消，未创建 attempt，避免第四次模型调用。

## 三次真实 provider

| 输入 key | execution | attempt | session | 结果 |
| --- | --- | --- | --- | --- |
| alpha1 | `24a92646-ff73-49d5-a05a-bff7faadd665` | `eb0569a2-ffb6-43d0-b71d-a0b9fd601bb6` | `5b45bc35-c1b5-4fcd-81e6-051f2f148b6c` | cancelled，可信 exit 0 |
| alpha2 | `905ce830-4276-4ba1-b2e0-da729ce6fe0d` | `d7aa3d4c-742a-4c57-9996-7f974855f776` | `5c7d8526-5071-42ce-8ffd-0531873d7c86` | completed，contract valid，exit 0 |
| beta1 | `98fb1e0e-2758-424f-b8de-0e83bd86d78e` | `5cf4595f-921a-4096-ab52-31cabcff7f8f` | `f42bca40-59c8-4227-8b04-cd63762bf458` | completed，contract valid，exit 0 |

alpha1 的原始事件包含 Read fixture 和 foreground `sleep 15`。公开取消时间为 `12:01:54.381Z`。取消发布后的独立快照是 `alpha1 unknown, alpha2 queued, beta1 running, beta2 cancelled`，alpha1 没有 stopConfirmation，发布本身没有释放 repo 名额。

alpha1 后续读取本 attempt 的 stop 文件，报告 fixture alpha 与真实取消原因，结束新工作。可信结束时间为 `12:02:17.257Z`，marker 为 `ORCH_EXIT_463affaa2c6259988a856911edd371dcf038a544749f11b2:0`。随后 alpha2 preparation gate 出现，公开状态 starting。alpha2 在独立 workspace 读取 alpha，报告 stop 文件不存在，于 `12:03:43.244Z` 结束，marker 为 `ORCH_EXIT_ba4ba468a9f1816f39ffb365e8acf3252236a4ae8d7ef1ba:0`。

beta1 读取 beta，最多四次 foreground `sleep 15` 并在各次后检查 stop 文件，均不存在。它正常结束于 `12:03:23.307Z`，marker 为 `ORCH_EXIT_9e7890ad70599821320a518494924155aa43490392c31fc9:0`。没有强杀真实模型，也没有通过停止 harness 制造退出证明。

三个 actual SHA 和容器内 `git rev-parse HEAD` 分别匹配各自输入 SHA。三个不同 workspaces/stop directories/session exports 无复用，rootfs readonly，所有 Agent bind mounts `RW:false`。可信退出后独立 `docker top` 均无活动 claude/node，公开 logs 均 complete。导出的 session 文件实际可读，字节数依次为 141238、136978、159636。

## 独立准备阶段重启

旧 alpha execution 为 `0aaeedf1-c570-4996-aa54-fedb39c8bd4b`，等待 alpha 为 `96210de1-f4cc-4e97-aae5-c9889aab67b6`，备用 beta 为 `55834e06-6874-4c47-a6fc-5403c58a25ed`。

旧 alpha 已进入 preparation gate。公开记录尚无 container identity，Docker 名称查验也无该 attempt 容器。独立控制服务收到 SIGTERM 后仍等待 preparation，因此本次按准备阶段 crash 授权停止该服务进程，收到 SIGKILL exit。没有已启动的模型、容器或外部任务。

重启同一数据目录后，旧 alpha 为 unknown且只有原 attempt，等待 alpha queued。beta 使用剩余 global 容量进入 starting。状态 `unknown, queued, starting` 证明 unknown 占额没有自动消失，且只阻塞自己的 repo。没有自动重跑旧 alpha。

独立确认旧服务退出且没有执行设施后，通过公开 confirm-stop 写入 operator、handling、reason 和 externalResults。审计时间为 `12:04:36.511Z`，kind manual。waiting alpha 随后 starting。旧 execution 仍显示 unknown，manual stop confirmation释放的是占额，不等于业务已 resolve。waiting alpha 和 spare beta 在 preparation 取消后才放行 gate，结束证据均为 never-started，没有模型调用。

## Harness 失败、测试和清理

首次独立配置把 data 放在 config 的子目录，控制服务以 `Runtime data must be separate from configuration and checkouts` 拒绝启动。无提交或执行，修为三个 sibling 目录后继续。

主 runner 在 alpha1 已可信取消退出后误断言 contract valid。产品取消路径不校验业务报告，因此该断言失败不证明产品缺陷。runner 保留服务和 relay，没有中断 beta1。continuation 复用现有资源完成 alpha2、beta1 和恢复验收。首次 deterministic 返回格式错误已如上记录，并用无新增模型调用的真实 Docker 补验。

目标 SHA 的 typecheck 通过。quota、management、agent 三个相关文件共 49 tests passed。完整 suite 为 10 files passed、155 passed、20 skipped。20 个 opt-in Docker tests 未启用，不能算作通过；本文真实 Docker 验收另行执行。

只有三个 provider 的可信 marker、导出 session 和实际进程检查完成后，才停止自己的已退出待机容器、主要控制服务和 relay。独立恢复服务也结束。保留本次数据、容器与原始证据供复核；没有删除共享网络/镜像或动他人资源，原 loopback CC-Switch 仍监听。容器事后清理退出码不作为 Agent exit code。

本次没有注入持久化失败、真正运行中的控制服务崩溃、provider 不配合、远端任务取消或动态 quota 配置变更。准备 gate 和手工确认属受控边界；真实模型、Docker fixture 读取、取消文件检查、可信退出和隔离证据属实测边界。没有发现需要产品修改的问题。

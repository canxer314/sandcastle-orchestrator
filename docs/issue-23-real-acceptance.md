# Issue #23：真实只读 MCP 验收（2026-10-11）

## 范围与运行

单一 CLI/socket vertical slice：真实 Claude Code builder → native MCP config → stdio discovery/call → 模型读取反馈。上游路径为 **Claude CLI → CC-Switch → Codex OAuth**，不是 Anthropic 直连，也不是 controlled harness。

用户授权当前主机专用测试容器、现有代理认证、临时无敏感仓库与只读 MCP。未复制 OAuth、修改 CC-Switch/全局设置、写入 GitHub 或业务系统。生产代码、持久化记录格式和管理协议没有因此变更；沿用现有 #23 changeset/README，不添加新的公共行为。

默认 `pnpm test` 不执行真实验收。以下命令只在获得模型费用和容器执行授权后运行：

```sh
ORCH_REAL_MCP=1 node tests/real-mcp-acceptance.mjs --without-mcp # 预期失败：没有 tools/call receipt
ORCH_REAL_MCP=1 node tests/real-mcp-acceptance.mjs               # 预期成功
```

脚本依赖本机 #19 专用设施，不是通用 provisioning：Docker 可用，镜像 `issue-19-acceptance:2.1.296` 完整 ID 为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`；内部网络 `issue-19-acceptance` 为 `10.231.19.0/28`，gateway `10.231.19.1`；现有 CC-Switch 在 `127.0.0.1:15721` 可用且有代理认证。脚本逐项核对镜像/网络，临时 relay 仅监听该内部 gateway 且限制来源；不创建替代登录路径。源码中的本机 settings 路径只供读取已有认证，配置和模型 prompt 不含凭据值。

执行只操作新建临时 fixture repo；native MCP 服务只返回反馈，无业务外部动作。Nonce 仅在 `tools/call` 收到后随机生成，不预先进入 prompt。独立 `docker exec` 读取 MCP receipt 与模型输出比对。设施断言覆盖 readonly rootfs、全部 bind mounts、native config mount、UID/GID、SHA 和模型/服务实际进程结束。退出证据未确认时保留控制服务/relay/容器供操作员调查，不强杀来制造成功；正常结束仅停止本次创建的资源，保留本机记录与容器。

## 实际结果

应用基线 `309e105`；Claude Code `2.1.296`。两个真正模型运行，没有重复 red 或 green。

- **Red**：execution `fd9ed3dc-e642-4ff3-b416-051c5b19f0b4`，attempt `d409d109-1cdf-40a7-9bf6-666f957dbbf8`，session `92e42cd3-c7c6-419d-b2d0-d8c067fe4e1c`。无 MCP 配置，模型输出 `UNAVAILABLE`，exit marker 为 0，service receipt 不存在。最初观察脚本的 `docker top` 未包含 PID 列而失败，随后修正为 `pid,comm`；通过公开 show/list 和独立进程检查补核实 red，不把该设施错误当作 MCP 断言失败。另两次 submit 前的依赖/数据目录准备失败未调用模型，不计为 TDD red。
- **Green**：execution `aa062682-f33a-4aae-b7c1-db00606cf945`，attempt `dad7fcd4-6a4a-4090-976d-2cff47d388f4`，session `7fc62955-7f32-487b-90c9-4372d8074b00`。service receipt 明确记录 `initialize`、`tools/list`、一次 `tools/call`，native tool 为 `inspect`。模型回传 service 运行时 nonce `dd51dfad-22b2-4d1f-9403-b12c2f8126ce`、`outcome: success`、`summary: readonly lighthouse feedback`、`logs.readable: false`、`remoteStopped: null`；exit 0、contract valid、logs complete，无 SDK error。
- Green 运行时已有 receipt/nonce/summary 与反馈限制断言，以及 readonly mounts/rootfs/UID 和进程检查。随后把反馈断言加强为 JSON 全对象相等，并新增 config mount/SHA/源 repo 无变更断言；没有重跑模型。已离线读取原 green 公开 show 输出核实反馈精确相等，筛选 Docker inspect 核实 `/orchestrator-mcp/readonly.json` 为 readonly。后加的 SHA/源 repo 断言未完整重新执行，不能声称整份最终脚本曾端到端重跑。

Green 容器退出后 `docker top` 仅 `sh`/`sleep`，没有 Claude CLI/MCP node；red 同样核对后停止。专用 relay、两次控制服务及核验时重开的控制服务已停止，两个测试容器均停止；镜像、网络及本地证据保留。没有停止既有 CC-Switch 服务。

本机筛选证据：`/tmp/issue-23-real-55j5xX/evidence.json`（red）、`/tmp/issue-23-real-Hdr9n8/evidence.json`（green）；运行记录分别在 `/tmp/issue-23-data-Hgeist/`、`/tmp/issue-23-data-ZGtSxC/`。原始 session/日志仅本地，不提交，不发布完整 Docker inspect/env。临时路径不是长期归档保证。

## 验证与边界

`pnpm run typecheck` 通过；主目录 CLI/socket roles/management：50 passed；主目录全套以 `--maxWorkers=1` 串行运行：6 files，103 passed、20 skipped。此前 `--maxWorkers=2` 并行运行出现两个 5 秒测试超时，不能称为通过；串行结果不抹去这次失败。20 个显式 Docker 测试未启用，不能算通过。两个 `.mjs` 文件通过 `node --check`。

### 清理保护回归（受控外部依赖，非真实验收）

复核发现 exit marker 已收到但 MCP 仍活跃时，旧 `finally` 虽不停止容器，却仍关闭控制服务与 relay。经用户确认，新增 `tests/real-mcp-acceptance.test.ts` 从脚本 command-line subprocess 入口验证；preload 仅替代外部 Docker/CLI、认证文件读取和 gateway 监听，使用虚构认证与临时 loopback TCP listener，不读取真实认证，不运行真实模型/容器，不替换脚本内部函数。

第一条 RED 的具体失败为受控控制进程已经收到 SIGTERM（`control-stopped` 存在）。加入独立进程缺席 gate 后，同一测试又发现 uncaught assertion 会退出脚本并销毁 relay。最终最小修复在失败时仅输出静态脱敏提示、设置 `process.exitCode = 1`，并在 cleanup 前重新核对 `docker top`；收到 exit marker **且**实际 CLI/MCP 缺席才能停止本次容器及关闭控制/relay。进程仍活跃或进程查询失败均保留全部资源并报告人工调查；脚本此时保持常驻，exitCode 仅在最终退出时生效，操作员须先独立核验实际执行与外部工作，再处理保留设施。不得强杀未知执行来让验收通过。

同一测试随后 GREEN；按 vertical slices 补充实际缺席正常清理、进程查询失败保持资源，前三条共 3 passed。断言实际控制 PID 存活/停止以及 TCP listener 可连接/关闭，不只是记录 close 调用。runner 最后仅清理自己创建的受控 fixture 进程。

第二项 P2 是 submit 接纳状态不明：服务可能已经接纳/启动，但 CLI 响应非零或 JSON 无效，不能以没有 receipt 推断尚未提交。第四条同 seam 回归由外部替身记录已接纳，再使 submit CLI 非零退出；RED 时前三条仍通过，新测试发现控制进程被 SIGTERM。最小修复在发出 submit **之前**标记可能已提交；仅明确 `accepted: false` 才释放此标记，缺失/无效 receipt 一律保留容器、控制服务和 relay 并提示人工调查。不新增自动查询、恢复或强杀。

修复后四条回归 GREEN。在 `309e105` 基线隔离 worktree 上，typecheck 通过；相关 roles/management/清理回归串行 3 files、54 passed；最终全套 `pnpm test --maxWorkers=1`：7 files、107 passed、20 skipped（125.80 秒）；三个脚本通过 `node --check`，`git diff --check` 通过。第一次清理修复的全套结果是 106 passed、20 skipped；本次新增第四条后为 107。本次未新增真实模型或容器执行，最终脚本仍未完整真实重跑。

本次仅证明一条真实只读 stdio happy path及未配置 MCP 时不可用。真实远端业务副作用、取消/重试/超时、CodeGraph 上下文绑定、其他 provider/transport 不在此验收范围；没有以 agent 退出推断远端工作停止，也没有把不可读日志称作已读取。

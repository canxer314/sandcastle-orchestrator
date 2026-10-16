# #81 执行级 localhost 桥验收

## 范围与基线

- 任务 [#81](https://github.com/canxer314/sandcastle-orchestrator/issues/81)，父任务 [#65](https://github.com/canxer314/sandcastle-orchestrator/issues/65)，实现 PR [#95](https://github.com/canxer314/sandcastle-orchestrator/pull/95)。
- 独立 worktree 分支 `issue-81-localhost-tcp-bridge`，初始已合并基线 `80bad49336a9ee7f30a678968215dfb28e411920`，含 #80 的连接投影与验收。不读取其他票未合并分支。
- 实现提交 `8da6e3548094b229bde83624426dc2c20998483d`。合并前同步 master `a1840f58e7eb3236488ecef69354cdb5192e9b04`，集成提交 `a0d8377c2a1b1304497d726e63cbd293b3d0ffa6`。#81 源码和测试与已审实现提交无差异，README 保留 #78 的已合并改动。
- Linux x86_64、Node.js v24.21.0、pnpm 12.3.4。Standards / Spec 两条独立只读审查均针对 `8da6e35`，各 0 项发现。没有数据库、管理协议或配置字段迁移。

## 原验收清单核对

以下编号对应 #81 原有六项 Acceptance criteria，不增加或改写关闭条件。

| 项 | 交付与受控证据 | 边界 |
| --- | --- | --- |
| 1 | 非 loopback endpoint 不创建桥或执行桥探测；HTTP loopback 从 Docker network 发现实际 gateway，核对对应本机 bridge 网卡，绑定临时端口；ready 后创建容器，以完整 ID 核验 running、network/IP，再启动 Agent。`connection.test.ts` 的 `role execution bridges…` 和 `role execution reads…`、`localhost-bridge.test.ts` 的 `execution bridge streams…` 验证地址覆盖、路径、授权前拒绝、其他来源拒绝及原容器停止后拒绝。 | 网卡、sysfs、Docker CLI 和容器身份为受控替身，不是真实 Docker 网络验收。 |
| 2 | 真实本地 TCP peer 验证 opaque binary bytes、FIN 后响应、双向 32 MiB 慢速传输的背压与完整性、上游连接失败；URL `/proxy/%2Fprefix` 及 HTTP 协议保持。relay 仅使用 Node `net` 双向 `pipe`，不解析或记录请求、认证及响应正文。 | 新 URL 的 HTTP Host 为 gateway/临时端口；依赖原 Host 或绝对 loopback redirect 的代理不在透明兼容范围内。 |
| 3 | role 测试覆盖容器创建/managed-settings 失败时关闭 relay，退出标记后关闭，协作 cancel 保留连接直至最终报告；缺标记时执行 unknown、桥仍存活，无 stop/kill/rm。 | relay 仅属于当前控制进程，控制服务退出会中断连接，重启不恢复桥；不等于 Agent 已停止。容器和证据保留规则不变。 |
| 4 | HTTPS loopback 在 Docker 操作前报 TLS/SNI 不支持；规范化 IPv4、IPv6、mapped loopback 同样拒绝，不注入关闭证书校验的开关。受控 remote、rootless、Desktop、非 bridge 和无法核验 gateway 均失败；显式容器可达 endpoint 保留原行为。源码与审查确认无提权、host 网络、防火墙修改或 Docker socket 注入。 | 不声称支持未知 TLS/SNI 或所有 Docker 配置。 |
| 5 | 本记录、README、连接指南和 PR 均区分受控验收与真实环境。只使用合成凭据及测试所属 TCP peer；未读取私人连接、运行真实 Docker、连接真实代理、调用真实模型或产生模型费用。 | 真实 Docker/代理/模型均为未验收，需要另行明确授权；不把 #80 历史真实验收移作 #81 证据。 |
| 6 | TDD 记录包含 HTTPS 拒绝和 role 自动地址覆盖的失败到通过；typecheck、相关 CLI/socket、role/provider 与 TCP 测试及完整套件已运行。README、连接指南、`.changeset/issue-81-localhost-bridge.md` 随增量提交。 | 合并前集成回归结果见下节。 |

## 验证命令与结果

实现提交已通过 `pnpm run typecheck`、`pnpm run build` 和以下完整受控命令，结果为 19 files passed / 1 skipped、360 passed / 21 skipped：

```sh
ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_MCP=0 ORCH_REAL_CONNECTION=0 \
  pnpm test --maxWorkers=1 --testTimeout=20000 --expect.poll.timeout=10000
```

早期并行回归遇到旧 CLI 启动/轮询超时，单独重跑通过。最终使用单 worker 和启动等待余量，未修改旧 CLI 测试默认超时。真实环境 opt-in 明确关闭，skipped 不算验收通过。

同步 #78 后，在集成提交 `a0d8377` 重跑 `pnpm run typecheck`、`pnpm run build` 和同一完整受控命令，全部通过：19 files passed / 1 skipped、**365 passed / 21 skipped**，耗时 439.56 秒。`git diff --check` 通过。GitHub 未配置 Actions、required checks 或强制 review，不把空 checks 列表或空 status 的 pending 值当作 CI 通过；合并依据为上述本地回归、已完成的双线审查和无冲突的最新 master 集成。

## 未验收项与父任务

#81 指定的独立验收 seam 是受控本地 TCP peer 与受控容器身份，不要求 setup、打包或真实代理作为前置。以上证据只覆盖这个范围。父任务 #65 的真实 Agent 接入、真实自动桥、代理路由/切换、安装发布等要求仍需各自证据，不能据此关闭父任务。

真实 Docker、私人代理和真实模型未执行。任何后续真实验收先取得对应环境、连接读取和费用授权，不自动拉镜像、不停止未知执行，不以控制服务或 Docker client 退出冒充安全停止。

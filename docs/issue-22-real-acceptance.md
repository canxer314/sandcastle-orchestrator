# Issue #22 真实 MCP 验收，2026-10-11

## 授权与范围

用户授权在当前主机沿用 #19 的测试范围，启动专用测试容器，通过已有 CC-Switch/Codex OAuth 登录路由调用模型。没有授权 GitHub 写入，没有复制 OAuth 文件或修改代理配置。目标是新建的无敏感内容临时 repo，不是业务仓库。

本文记录实际执行证据。参数错误、未知结果及断连故障还需结合受控 MCP 传输测试核对，不把受控故障冒充真实模型产生的结果。

## 环境

- Node.js `24.21.0`，pnpm `12.3.4`，Docker Engine `29.8.1`。
- 固定 Sandcastle `0.12.0`、Effect `3.20.0`，官方 MCP server/client SDK `2.3.1`。
- 角色镜像 `issue-19-acceptance:2.1.296`，ID `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。真实 CLI help 确认 `--mcp-config` 和 `--strict-mcp-config`。
- 测试能力镜像 `node:22.22-alpine`，无网络、无角色认证环境。
- 复用专用测试网络 `issue-19-acceptance`。临时 relay 仅监听 `10.231.19.1:15721`，只接受该网段连接并转发到本机 `127.0.0.1:15721`。没有 host network 或公网监听。
- 临时 repo SHA `e79a20c47b3f59706b077c3dc294b6127429fb6b`。测试脚本明确提供成功、业务失败和大日志范围。

## 真实 provider 调用

公开 CLI/socket 提交 `fixture/report`，execution `f3d01c72-f916-437d-a151-b1b9cdeacfca`，attempt `42c01283-41e4-46a5-bc8c-33013bf03932`。

真实 session `58a39505-85ad-4264-a07d-343e4ff22d26` 包含以下工具调用，不只是一份模型自述报告。

| 调用 | 实际结果 |
| --- | --- |
| `mcp__orchestrator__run_tests`，scope `success` | call 1，completed、valid、exit 0。 |
| 同工具，scope `failure` | call 2，completed、valid、exit 7，business `passed: false`。 |
| 同工具，scope `large` | call 3，completed、valid、exit 0，stdout 为 180,019 字节。 |
| `mcp__orchestrator__read_tool_file` | 读取 call 3 的 stdout，offset 0 与 131072；返回 `LOG-BEGIN`、`LOG-END`，末块 `truncated: false`、`complete: true`。 |
| `mcp__orchestrator__run_tests`，scope `fault` | call 4，start_failed，Docker inspect 显示 created，缺失 entrypoint。没有伪装成测试断言失败。 |

父 Agent 结束为 completed、valid、exit 0。日志包含真实退出 marker `ORCH_EXIT_0d38754655864b37c98cb3a39f087dc871d87f653b39ab25:0`。`docker top` 只剩待机 shell/sleep，没有活动 Claude CLI。

## 双入口与访问限制

同一 `test-commit` 能力通过独立 CLI/socket 再次提交 scope `failure`。execution `f4057165-b2a3-470f-b1b7-8bd2eb8e2085`，attempt `cc571b4b-73e4-4634-85d9-bf30a682627f`。固定 SHA 相同，结果为 completed、valid、exit 7、`passed: false`，stderr 为 `fixture assertion failed`。独立执行有自己的目录，不共享角色尝试或模型认证。

筛选后的 Docker inspect 证明角色的 workspace、Git metadata、stop 和 MCP 目录均 readonly，rootfs readonly，UID/GID `1000:1000`。工具容器 `/workspace` readonly，只有 `/artifacts` 和隔离 `/tmp` 可写，network none。没有 Docker socket、完整管理 socket 或宿主 home 挂载。实际探针确认角色 workspace 不可写，临时源 repo 未改变。

MCP stdio 桥是角色 CLI 启动的 Node 子进程，经当前尝试专属 Unix socket 连接宿主官方 MCP SDK。Agent 退出后受限 socket 已关闭，不把 socket 关闭当成工具停止证据。四次工具调用留在原 attempt 的记录中，没有新顶层请求或尝试。

控制服务重启后，公开 show 的完整 attempts 逐字段相同，仍为一个 attempt、四个 toolCalls，没有自动重跑。

## 审查修正后的复验

修正执行复用和双入口只读契约后，显式配置 `test-commit.execution.workspace: 'readonly'`，重新通过公开入口提交。角色 execution `fb4aaeca-06b2-464a-bcaa-89d5f502f1ce`，attempt `e0c96a7e-3f36-4262-b1c9-8c7ace8fa95c`；独立 execution `e102194a-27cf-494d-ae0d-6e7db047c308`，attempt `593632b1-b61c-4086-8b82-8cee4da482d8`。

四次 MCP 调用结果与首次一致，父角色 completed、valid、exit 0，完整日志可查。真实退出 marker 为 `ORCH_EXIT_0b0295ec29438e06c27978d6a35db65cfa7917703537a801:0`。独立 failure 为 completed、valid、exit 7。实际 inspect 确认这次两个入口的 `/workspace` 都 readonly，测试容器仍为 network none。

角色活跃期间，另用官方 client 经真实 `docker exec -i` stdio 桥调用。`listTools` 返回 `run_tests` 与 `read_tool_file`；附加伪造 `attemptId`、`workspace`、`credentials` 的请求返回 `isError: true` 和 unrecognized keys 校验错误，没有启动测试。该检查验证了真实工具进程和参数边界，不是 mock transport。

## 证据保存与限制

原始日志、session、临时配置及筛选后的 inspect 位于本机 `/tmp/issue-22-acceptance/` 与 `/tmp/issue-22-acceptance-data/`，未上传。这些临时目录不构成长期归档承诺。凭据值不写入本文。

最后的摘要修正只调整 JSON 编码后的字节预算，采用带大量引号的业务结果经官方 MCP stdio 做受控回归，不额外调用模型。上述最终真实运行已覆盖共享执行、只读双入口及 provider 接法。

确认两次真实 Agent 均已退出后，停止专用控制服务和 relay。对两个剩余待机容器执行 `docker stop --timeout -1`，该协作停止仍在等待，容器仍显示 running，不能宣称容器清理完成。没有强杀或删除容器，镜像、网络和原始证据保留。

本次验证了上述 provider 路径的实际 MCP 配置、工具进程、挂载、上下文及成功/业务失败/执行故障/大日志读取。其他 provider、真实协作取消响应和所有子进程停止不在本次证据范围。

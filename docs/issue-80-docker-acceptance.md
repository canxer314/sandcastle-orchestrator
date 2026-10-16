# #80 真实 Docker 受控连接验收

## 范围与授权

2026-10-16，用户明确授权本机 Docker、现有镜像、本次测试容器/临时资源、合成凭据和受控 endpoint。未读取私人连接、宿主 settings 或凭据库，未调用真实模型、拉取镜像、发布代码或修改远端 Issue。

本增量补齐 #80 第 2 项所缺的真实容器执行证据，不重复实现已合并的连接投影。生产实现基线为 `e984d265356e10768fcf36a9225f7acc253c457a`，含 #87。新增可选测试为 `tests/real-connection.test.ts`，不改生产接口、记录、socket 协议或默认测试的外部访问行为，故无新的公共行为 changeset。

## 环境与命令

- Linux x86_64，Node.js v24.21.0，pnpm 12.3.4。
- 本机 rootful Docker Engine client/server 29.8.1。
- 预部署镜像 `issue-19-acceptance:2.1.296`，按本地内容 ID 固定为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`，不是远端 registry manifest digest。
- 镜像内原版 `claude --version` 为 `2.1.296 (Claude Code)`，Node.js v24.21.0、Git 2.39.5。版本检查容器使用 `--network none --pull=never`，不挂载宿主资源。
- 主 seam 为真实 CLI 子进程 `serve` / `submit` / `show` / `logs`，经现有 Unix socket、role runner、Sandcastle 0.12.0、连接投影与容器内原版 harness。仅 Messages 服务端是测试实现，不是模型服务。

授权环境复跑：

```sh
pnpm run typecheck
ORCH_REAL_CONNECTION=1 pnpm test tests/real-connection.test.ts
```

本机 Docker 默认地址池已耗尽，首次运行在创建网络时失败，没有提交任务；未清理或复用其他项目网络。核对路由及现有 Docker 子网后，最终通过命令为：

```sh
ORCH_REAL_CONNECTION=1 ORCH_CONNECTION_SUBNET=10.231.80.32/28 \
  pnpm test tests/real-connection.test.ts
```

该子网是本次已核对的选择，不是可在任意主机照抄的默认值。重跑需要选择无冲突子网，测试不会删除既有容器/网络腾出地址。

## 实测证据

完整通过运行的临时目录为 `/tmp/issue-80-real-spA2EL`。`evidence.json` 保存非敏感请求元数据、attempt/session 定位、退出确认及秘密检查结果，`cleanup.json` 独立保存收尾结果。临时 Git repo 固定 commit 为 `497dc867aaa3e8bd2e3e0d5dbb7927b19fd965c6`。

复核 SHA-256：该次测试文件 `c98a419b95c4b5ab82a263d9008cf0a2d31fb9b8771d0c12feade228eea200b9`，`evidence.json` 为 `af699e912e8523eaa9393845420b365a4f95158535a868d28a8a33357e0da343`，`cleanup.json` 为 `019f74993f9e118c7d39ec745870adcc10b393a878368a18bc9aab2947a8777d`。临时证据应由操作者在主机清理前保留，仓库文档不包含合成秘密或原始请求正文。

| 执行 | attempt | endpoint 观察到的 model | 请求来源 |
| --- | --- | --- | --- |
| 无显式 override 的首次执行 | `21d72149-a376-4724-8eb7-1333b79d6dfa` | `backend-a` | `10.231.80.34` |
| live settings 切换后的下一次执行 | `041ed9b6-0994-40c2-836f-d21bf361763f` | `backend-b` | `10.231.80.35` |
| 显式 provider override | `dadf3890-0f58-47d5-a506-3ed157e4f5f7` | `backend-override` | `10.231.80.36` |

- 首次请求等待响应时更新所选 settings，之后才释放响应。首次请求保留旧模型/认证，下一次无需重启服务即使用新值。
- 三次请求均为原版 harness 发出的 `/v1/messages?beta=true`，来源 IP 分别与 Docker inspect 中各自容器 IP 相同；Bearer 与 custom header 均匹配本次选择，证据只保存布尔结果，不保存值。
- endpoint 仅绑定专用 internal network gateway 的临时端口。没有 localhost 转发、host 网络、Docker socket 挂载、宿主执行回退或真实后端访问。服务端只返回固定文本 SSE，不发 tool calls。
- 每次均 `completed`、`exitCode: 0`、`contract: valid`，并有 `agent-exit-marker`。固定 SHA 与容器内 HEAD 一致，源 repo 工作树保持干净。
- 检查 readonly root、全部 bind mounts 只读、`CapDrop: ALL`、`no-new-privileges` 和专用网络。真实执行仍使用现有 UID/GID、tmpfs 与固定树设施。
- 服务端刻意回显合成 token/header。CLI 查询、日志、业务报告中均为 `[REDACTED]`；扫描整个 data 和隔离 HOME 下导出的 `.claude` session 目录，均无这三项原始秘密。合成秘密只存在于测试明确选定的临时来源 JSON 和运行时环境，不放入可信配置/任务输入或证据摘要。
- 三次 marker 确认时间分别为 `2026-10-16T07:07:27.753Z`、`07:07:29.539Z`、`07:07:31.347Z`。随后独立 `docker top -eo pid,comm` 确认无 Claude/Node 进程，才停止本次保活容器。`cleanup.json` 核实三个容器 `running:false`、本次控制服务已退出、endpoint 已关闭。
- 保留已停止的证据容器、所附网络和临时文件，不自动删除。保活容器自身退出码不代替 harness marker；Docker Config.Env 仍可能保留合成凭据，容器/获授权 Docker 管理者可见的边界未改变。

一次早期运行已完成首次请求，但进程查询误用 `docker top -eo comm`，Docker 要求 PID 列而报错。改成 `pid,comm` 后重跑全部三次通过。早期容器也先核实 marker 与实际进程缺席，再停止自身容器/控制服务；不计入上述完整通过证据。

审查后仅修正失败路径的 endpoint 保留说明，再以 `ORCH_CONNECTION_SUBNET=10.231.80.48/28` 重跑完整三次通过。最终测试文件 SHA-256 为 `8ed68ab12c49c705fc6bbbeead7be5c5ca2fe4b7c440c4d0f91b9cd7475da285`，证据位于 `/tmp/issue-80-real-brFJui`，fixture SHA 为 `7e11f317f1e654b0600eefa83276a6bf1f3d268e`。对应三个 attempt 为 `48d72aeb-d9a7-43f0-b4ee-5cbb79955b33`、`45b4e036-1adc-4f3f-b871-ba547f6cd11e`、`f5b54146-ab35-4dbd-80af-cd45e215dc3f`，均 exit 0、marker 确认、秘密过滤及收尾核对通过。`evidence.json` SHA-256 为 `800908b5da762b2ca230486a1c5bbbfdcc8d76478e5c3eeb6592a3a0117fac61`，`cleanup.json` 为 `e8ff456c0be94e3786b212e396f60f8264284177ce858ed3bce7e99633a870c8`。

## 回归与未验收项

`pnpm run typecheck` 通过；现有 `connection`、`roles`、`agent`、`management` 四文件定向回归为 135 passed。提交前运行 `ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_MCP=0 ORCH_REAL_CONNECTION=0 pnpm test`，结果为 14 files passed / 1 skipped、273 passed / 21 skipped；新增真实连接测试另行 opt-in 运行通过，三次真实容器尝试均通过。

新增测试默认 skip，必须单独设置 `ORCH_REAL_CONNECTION=1`。它不依赖 setup、正式安装或 localhost 桥，也不启用其他真实 Docker/MCP/provider opt-in。

失败收尾有一项限制：缺少回执、marker 或进程核对时，测试不会主动停止容器/控制服务，但受控 endpoint 属于 Vitest worker，runner 退出可能关闭它，不承诺未知执行仍有可用连接。该失败路径未作独立 retention 验收；需要此保证时应改用独立常驻验收进程，不能把本次成功路径当作证明。

本记录证明指定镜像/CLI 版本的真实容器可达受控 endpoint 执行。它不证明真实模型质量、任何私人身份可迁移、所有后端/镜像兼容、代理路由/failover、自动 localhost 桥或真实协作取消已验收。无显式 `--model` 的命令省略及异常冲突分支继续由原有受控测试覆盖；这里独立观察原版 harness 实际发出的模型字段。

远端 #80 清单和状态没有修改，本地通过不授权自动关闭 Issue。父任务 #65 的真实 Agent/后端验收仍需各自授权和证据。

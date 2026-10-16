# #82 真实容器 setup 入口验收

## 范围与授权

2026-10-16，用户明确授权本机 Docker 探测、镜像构建及依赖下载、本次容器/网络、合成凭据和本地受控 endpoint。不授权读取私人连接、调用真实 provider/模型或产生模型费用。基线为已合并 master `6376b0aff2156138d575f382763a3d2b3e1af8e2`，独立分支 `issue-82-container-acceptance`。

新增 `tests/real-setup.test.ts`，默认 skip，只有 `ORCH_REAL_SETUP=1` 才执行。它从源码外安装当前 tgz，运行正式 setup，再原样执行生成的 serve/submit 命令；不会加载用户项目 TS，也不绕过既有 provider/role runner。未改生产接口、协议或记录格式。

## 两项结果必须分开

| 验收 | 结果 |
| --- | --- |
| 生成的推荐 Dockerfile 构建 | **未通过，环境阻塞**。Docker 拉取 `node:24.21.0-bookworm-slim` 元数据时，`auth.docker.io` 在本机 DNS `127.0.0.53` 查询失败。没有构建出推荐镜像，不将旧镜像重新打标签冒充产物。 |
| 显式自定义已有镜像，经 setup 生成入口取得容器报告 | **通过**。`--image issue-19-acceptance:2.1.296`，实际内容 ID 与 CLI 版本均核验。没有隐式 fallback。 |

因此已补充第5条的真实容器 endpoint 执行证据，但推荐镜像仍未核验，#82 保留责任和缺口，不能据自定义镜像成功宣称全部完成。真实模型答案质量也未验收。

## 环境与命令

Linux x86_64，Node.js v24.21.0，pnpm12.3.4，Docker client/server29.8.1。本机默认 bridge gateway 为 `172.17.0.1`，endpoint 只绑定该 gateway 随机端口。没有 localhost relay、host network、Docker socket挂载或真实后端连接。

默认完整命令会构建生成 Dockerfile，可能联网下载依赖：

```sh
ORCH_REAL_SETUP=1 pnpm test tests/real-setup.test.ts
```

本次网络不通，隔离 npm 安装也先因下载超时失败。显式复用公共 npm cache 可离线安装，不读取宿主 `.npmrc` 或认证；以下命令只消费已核验的自定义镜像，不构建推荐镜像：

```sh
ORCH_REAL_SETUP=1 ORCH_SETUP_NPM_CACHE=/home/canxer/.npm \
  ORCH_SETUP_IMAGE=issue-19-acceptance:2.1.296 \
  pnpm test tests/real-setup.test.ts
```

`ORCH_SETUP_NPM_CACHE` 可省略；指定时 npm 使用 `--offline --cache`，只访问公共包缓存。`ORCH_SETUP_IMAGE` 显式对应 setup 的 `--image`，证据包含 `recommendedImageBuilt:false`。test 用已安装 TypeScript 编译器构建后执行 `npm pack --ignore-scripts`，避免隔离 HOME 下 Corepack 额外下载。这不替代已有 package tests 对 prepack 的检查。

推荐构建失败证据为 `/tmp/issue-82-real-setup-offline.log`，对应资源 `/tmp/issue-82-container-ub37fh`。此前两次打包 fixture PATH/Corepack 修正、一次 npm JSON形状修正和一次隔离安装180秒超时均在进入容器执行前失败，不计为容器验收通过。

## 实测证据

最终自定义镜像运行1项通过，18.00秒，证据目录 `/tmp/issue-82-container-Ktq6yP`。真实镜像为 `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`，`claude --version` 输出 `2.1.296 (Claude Code)`。此 ID 是已有镜像本地内容 ID，不是推荐 Dockerfile 或 registry digest。

- fixture 固定 SHA `8881fe7b69a061ba1172b4231c83ca6d87f7964c`。setup 识别 dirty 工作树并固定此 SHA，生成输入含明确问题；执行后源 README 未提交标记保持不变。
- attempt `559932c4-a3a7-4263-9105-9844385d91a4`，容器 `orch-559932c4-a3a7-4263-9105-9844385d91a4-1`。
- 本地 Messages endpoint 先返回原生 `Read` tool_use，原版 CLI从只读 workspace读取README，再回传含 `SETUP_PINNED_82`、不含 `SETUP_DIRTY_82` 的工具结果；第二次响应提供可读报告。两次请求来源都是容器IP `172.17.0.5`，不是宿主fixture HTTP调用。
- 两次请求认证/header与合成来源匹配，模型为继承的 `controlled-setup-backend`。没有 provider mapping、私人连接或真实模型请求；报告为受控服务文本，不冒充模型结论或测试证据。
- `show --human` 读取完整报告及固定标记，业务文本含原样文件和调用关系；不是只检查 completed/contract。报告刻意回显合成token/header，持久化结果为 `[REDACTED]`；扫描所选 data 与隔离HOME/session未见原始秘密。
- Docker inspect验证 readonly root、所有bind mounts只读、`CapDrop:ALL`、`no-new-privileges`；容器内Git HEAD与固定SHA一致。tools为空，不授予编排器测试、修改、发布或发布凭据。harness 原生工具和tmpfs写入仍可用。
- Agent exit marker于 `2026-10-16T15:02:51.930Z` 确认exit0。随后独立 `docker top -eo pid,comm` 核对无Claude/Node进程，才停止本次保活容器；`cleanup.json` 核实容器停止、控制服务退出和endpoint关闭。保留已停容器及临时证据，未删除其他资源。

SHA-256：`evidence.json` 为 `b19240bb3989d184e60ba7674a56cac1f7ad8f6baf635db7d549a6f3ad3e04d2`，`cleanup.json` 为 `d684be9c1e8a33fdb83f0f8ec4322e23db85268299821544a0c3b210987d91a4`。生成Dockerfile为 `d41fcb00afff02d51a3144c7f69ffef66d91daf9429255f8f7f1a4a584bf356b`。

早期同一自定义镜像完整运行也通过，目录 `/tmp/issue-82-container-cXm9MC`，用于核对报告与停止流程；最终运行新增明确镜像选择/构建布尔证据后再次通过，不复用旧结果冒充最终版本。

审查修复后再跑完整自定义镜像入口，1 passed、16.74秒，最终证据目录 `/tmp/issue-82-container-6TY1mm`。fixture SHA为 `90fba8c6474d6d5dc8c8fd55ec310ec4f8a1f122`，attempt为 `87357eef-fb95-41a1-91fa-daa4ceb64ac0`，容器为 `orch-87357eef-fb95-41a1-91fa-daa4ceb64ac0-1`，请求来源 `172.17.0.4`，exit marker确认于 `2026-10-16T15:05:48.585Z`。报告/读取/秘密过滤/只读/独立停止检查及收尾再次通过。最终test SHA-256为 `4d914f94561e6c8bc796ef49173bfd1307c91f3aab060a904f016c7aca9d97c6`，`evidence.json`为 `2db22f755ac4ca22caf76067d8eadafb531bd25f63efb6d583a68634b3a7eac6`，`cleanup.json`为 `5a3a36b0eec62b798454a29c841d605c611c916dd22381733bdee179734f9802`。

## 回归与限制

typecheck/build通过；setup/connection定向38项通过。Standards发现失败诊断可能回显合成secret、测试名可能把自定义镜像误写为推荐构建，两项已修复并静态复核。Spec静态复核未发现本轮范围新增阻断，明确推荐构建仍未验收。reviewer仅直接阅读测试，未运行Docker；实际运行证据由主会话核对。完整常规回归 `ORCHESTRATOR_REAL_DOCKER=0 ORCH_REAL_MCP=0 ORCH_REAL_CONNECTION=0 ORCH_REAL_SETUP=0 pnpm test --maxWorkers=1 --testTimeout=20000 --expect.poll.timeout=10000` 通过：**20 files passed /2 skipped，378 passed /22 skipped**，428.00秒。新增真实setup测试在此命令明确skip，单独授权运行结果如上，不把skip计为通过。`git diff --check`通过。

缺回执或Agent停止证据时，不强杀容器/控制服务，不以它们退出制造成功。受控endpoint属于Vitest worker，失败退出时可能关闭；此测试只验收成功路径，不保证unknown执行的endpoint持久化保留，相关限制明确留在代码中。

#82尚需在网络恢复后的明确授权环境构建生成的推荐镜像并核对实际image ID/CLI，再运行默认验收入口。#65的真实provider、私人连接、后端/代理切换、真实模型答案及费用验收保持独立，不能据本次受控Messages服务成功关闭父任务。

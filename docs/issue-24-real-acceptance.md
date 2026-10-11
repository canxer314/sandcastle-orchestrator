# Issue #24 真实验收，2026-10-11

## 授权与环境

用户单独授权在当前 repo `canxer314/sandcastle-orchestrator` 验证真实 app CLI/socket、provider、Docker、MCP、普通 push 与 Draft PR。只允许专用 `orch/ATTEMPT` 分支，不推产品实现分支，不合并、评论、创建或关闭 Issue、改设置或部署。本次业务目标只补 `examples/pr-analysis.ts` 的 Issue 来源与版本说明，不冒充 #24 或 #25 已解决。

已读 #24、父规格 #14、tracker/domain 指引与 #19/#22 真实验收记录。应用运行提交为 `14a9aa7`，代码样例基线为当时远端 master `806ff4c74af8073d85efea2e0e7bfc61ecd07f8a`。普通配置直接导入 `examples/implementation.ts` 的角色与工具，再配置已有 provider/image、只读 `test-commit` 能力和固定 GitHub 发布目标，没有把模型内部调查/修改步骤写进 scheduler。

镜像 `issue-19-acceptance:2.1.296`，ID `sha256:0bb6dcc78a58bcded4f7da20771bcdb8edb1c65048e9bc7e383d8c4e668bd193`。Sandcastle `0.12.0`，真实 provider 是已有 Claude Code CLI → CC-Switch → 已登录 Codex 路由。沿用管理员既有默认 Opus 映射，不迁移 SDK，不证明 Anthropic 直连或其他 provider。

私有配置和数据分别放在 `/tmp/issue-24-acceptance-af60/`、`/tmp/issue-24-acceptance-af60-data/`，目录 0700，配置、SQLite、管理 socket 为 0600。没有读取或输出 GitHub 凭据值。仅 host writer 使用已登录 gh 的认证目录和 credential helper，发布目标精确固定为本 repo、base master、当前 attempt 专用分支。模型与测试不挂载 host home/GitHub 认证目录。独立容器探针确认模型没有 GH_TOKEN/GITHUB_TOKEN/GH_CONFIG_DIR 等变量，也看不到 gh hosts 文件。writer 的 host 网络 proxy 不传给模型或测试。

模型网络仅通过已有内部 `issue-19-acceptance` 网络上的受限 relay 到本机 provider。relay 监听 `10.231.19.1:15721`，按网段来源检查，仅转发到 `127.0.0.1:15721`；它不是 GitHub repo 权限代理。代码源和 SDK Git metadata 只读，模型只写 `/implementation` 的独立 clone，clone 移除 origin。测试和 revision capture 无网络，无模型或 GitHub 认证，测试 `/workspace` 只读。rootfs 只读，没有 Docker socket、管理 socket 或宿主 home 挂载。

## 首次运行与人工核对

公开 CLI/socket 接受 execution `561ee42b-6604-496a-aebe-5f83a9ea63f7`，attempt `2739d53e-0afc-4c38-9f7f-59b139c9551d`，branch `orch/2739d53e-0afc-4c38-9f7f-59b139c9551d`，配置版本 `issue-24-real-af60-14a9aa7-v1`。

真实模型读取样例、README、配置和角色代码，自主 Edit 三行注释，仅改获准文件。实际 MCP `run_tests` callId `1` 完成，exit 0、contract valid、business.passed true。测试捕获 dirty revision，HEAD/base `806ff4c74af8073d85efea2e0e7bfc61ecd07f8a`，tree `841ea87930579641d63e66f7d16543cdc460b595`，committed tree `3a00730fd927ee47979c53ec96eda65edce467c6`。stdout 为 `PASS: example Issue traceability, config/code version provenance, existing scoped role/tool bindings preserved`。独立比较移除注释后的代码逐字相同。

模型实际调用 `publish_draft` 后收到 unknown，随后 query 同一 callId，没有盲目再次发布。writer 精简环境未配置本机已有网络 proxy，首次 `ls-remote` 报 `Could not resolve host: github.com`，尚未记录 intended push。query 也失败。父模型自然 exit 0，但 app 正确保留 unknown，不用正常进程退出冒充发布成功。

独立 GitHub API matching-refs 返回 `[]`，对该 head 的 all-state PR 查询也返回 `[]`。独立 `docker top` 只剩角色待机 sh/sleep，没有 Claude CLI；revision/test 两个容器 inspect 都为 exited、exit 0。随后用公开 `confirm-stop --call 1`、parent `confirm-stop` 和 `resolve` 保存停止、外部副作用核对及原因。不停止或删除容器，不重发旧 publication call。

仅修改普通部署配置，在 `repo.publication.env` 传入既有 host proxy 变量，再在旧模型与工具已结束后优雅重启专用控制服务。未改产品代码或模型访问范围。用新请求和新分支复验，旧记录与日志保留。

## 独立基线检查与回归

同一 `test-commit` 能力另经公开 CLI/socket 在未修改的基线执行，execution `58f6552f-9ab0-4ba9-972a-1c3a998900e9`。真实无网络 Docker 返回 completed、contract valid、exit 1、business.passed false，断言明确指出缺少来源 Issue #25。这证明定向检查能拒绝原始样例，不是恒真测试。

应用 worktree 的 `pnpm run typecheck` 通过；相关 `tests/management.test.ts tests/roles.test.ts tests/mcp.test.ts` 为 91 passed；全套为 11 files、200 passed、20 skipped。20 项默认跳过的真实 Docker 单元用例未启用，不能算通过。本次上述真实 CLI/socket/provider/Docker/MCP 运行单独保留，不以常规 suite 替代。

## 最终真实发布与独立验证

新 execution `ea21494b-7978-4f30-bf1d-878ed717cfda`，attempt `7b65d4d4-b643-4219-aa19-5c3b47cf5c01`，配置版本 `issue-24-real-af60-14a9aa7-v2`。这次模型重新调查 README、配置和角色代码，自主新增四行注释，与首次修改并非复用固定脚本。只改 `examples/pr-analysis.ts`，增加 #25/#14 引用，区分部署配置版本、`input.sha` 和快照 PR `headSha`。独立比较移除注释后的内容与基线逐字相同。

实际 MCP `run_tests` callId `1` 返回 completed、valid、exit 0、passed true；测试 stdout 与首次相同，stderr 为空。capture HEAD/base 仍为 `806ff4c74af8073d85efea2e0e7bfc61ecd07f8a`，dirty tree 为 `652bb16f8b93165520f9af9c9645bf8a28fea05b`，测试使用隔离导出树，非原工作区。公开 `logs --call 1` 读到了完整 revision 与 PASS 日志。

模型实际调用 `publish_draft`，host writer 单 ref 普通 push 后核对远端 SHA，再创建 Draft PR。实际产物为 [Draft PR #45](https://github.com/canxer314/sandcastle-orchestrator/pull/45)，branch `orch/7b65d4d4-b643-4219-aa19-5c3b47cf5c01`，commit `a200091bf38a4d3c33b4c19291d43957c454e71d`。publication observations 保存 intended commit/tree、push verified receipt 与 PR receipt。拿到 URL 后立即调用 t3-code link_pull_request 登记，返回 `alreadyLinked: false`。结束时 list_thread_pull_requests 再次返回本线程 #45、open、isDraft true、相同 head/base。

独立 GitHub API 查询 PR、ref、Git commit 与 changed files，验证 draft true、state open、merged false、目标 repo 正确、base master、head/ref 都为上述 SHA/branch。commit tree 精确等于测试树 `652bb16f8b93165520f9af9c9645bf8a28fea05b`，唯一 parent 为基线 `806ff4c74af8073d85efea2e0e7bfc61ecd07f8a`。远端 diff 仅一个文件、四行新增注释、零删除。PR 正文引用 #24，明确这是有限验收，不关闭或解决 #24/#25，没有声称全套模型测试通过。

真实 session 为 `74eb5013-320a-4466-b783-bf9dd2cba5ac`，已独立找到 DATA 的 `sessions/-tmp-issue-24-acceptance-af60-data-attempts-7b65d4d4-b643-4219-aa19-5c3b47cf5c01-repo/74eb5013-320a-4466-b783-bf9dd2cba5ac.jsonl`。父 attempt 自然结束为 completed、valid、exit 0、logs.complete true。真实退出 marker `ORCH_EXIT_bb7831a6d4b18a2ff9f0888a57bc2af136cc4f0471126f09:0`。独立 `docker top` 只剩 sh/sleep，没有 Claude CLI；revision/test 容器 inspect 均 exited、exit 0，network none，test `/workspace` readonly。角色容器仍 running 待机，rootfs readonly、UID/GID 1000:1000，只有 `/implementation` 可写，源 workspace、Git metadata、MCP 和 stop mount readonly。首次待机角色容器也保留，未自动 stop/remove。最终专用控制服务与 relay 仍运行，没有自动清理。

## 证据位置与限制

原始 app receipts、show、模型 stdout/stderr/session、revision export、test stdout/stderr/result.json、筛选后的 inspect/top、GitHub 独立查询及回归输出都保存在上述两个私有目录。主要文件为 `receipt-v2.json`、`show-v2.json`、`test-v2-logs-cli.json`、`tool-use-v2-summary.json`、`independent-verification.json`、`github-pr45.json`、`github-commit.json`、`github-ref.json`、`github-files.json`、`final-top.txt`、`final-inspect-filtered.txt`、`regression-output.txt`。模型工作区和导出树分别位于 DATA 的 `attempts/7b65d4d4-b643-4219-aa19-5c3b47cf5c01/implementation/`、`tools/1/revision/`。原始日志/session 未提交或上传，本文不含认证值。临时目录不构成长期归档保证。

首次模型错误地以 `kind: artifact` 读取工具 stdout.log，返回 Artifact not registered。公开 CLI `logs --call 1` 独立读取了实际完整日志。模型容器没有 pnpm，不能声称它运行了产品 typecheck 或全套测试；host 回归是分开的证据。定向业务检查只验证这个 comment-only 样例，不代表一般实现任务的业务质量或完整 #24 验收。取消、远端响应丢失、真实 PR 创建未知等故障覆盖不能从本次正常路径推断。

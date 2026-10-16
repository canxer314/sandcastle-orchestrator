# 使用指南：Issue 到 Draft PR

把一个 GitHub Issue 交给已配置的 Sandcastle implementation 能力，它会在隔离分支中尝试实现、运行测试并创建 Draft PR。你得到的是待审查的 Draft PR，不是自动合并的改动。

目前没有网页 UI，也不能把 Issue URL 直接提交；服务不会自动拉取 Issue。每次使用前，管理员必须先部署并交付以下信息：

- 应用目录 `APP` 的绝对路径。
- 数据目录 `DATA` 的绝对路径；控制 socket 位于 `$DATA/control.sock`。
- 已登记目标仓库的 repo ID。
- `implementation` 能力、测试工具和 Draft PR 发布权限已配置并完成部署验收。
- 该仓库本地 checkout 中可访问的固定基线 commit SHA。拿不到这些信息或配置未就绪时，单靠复制本指南无法提交。

## 每次使用

以下命令在部署 Sandcastle 的 Linux 主机上运行，不是在任意电脑上运行。服务应已启动；终端需要 `git`、`gh`、`jq`、`pnpm`，且 `gh` 已登录具有目标 Issue 读取权限的账号。

### 第一步：选仓库和 Issue

先设置管理员交付的路径和 repo ID，并填写目标 Issue 编号：

```sh
export APP='/管理员交付的/app/绝对路径'
export DATA='/管理员交付的/data/绝对路径'
export REPO_ID='管理员交付的repo-id'
export GITHUB_REPO='OWNER/REPO'
export ISSUE=123
```

`APP` 指 Sandcastle 应用目录，`DATA` 指其运行数据目录，`REPO_ID` 是管理员在服务配置中登记的 ID；`GITHUB_REPO` 是 Issue 所属 GitHub 仓库，必须与该登记 repo 对应。`ISSUE` 是正整数 Issue 编号，不是 PR 编号。

### 第二步：读取 Issue 内容

从 GitHub 读取目标 Issue 正文；这一步只读 GitHub，不会提交任务：

```sh
ISSUE_BODY="$(gh issue view "$ISSUE" --repo "$GITHUB_REPO" --json body --jq .body)"
test -n "$ISSUE_BODY" || { echo 'Issue 正文为空或读取失败' >&2; exit 1; }
```

### 第三步：选择从哪个代码版本开始

从目标仓库的本地 checkout 读取管理员指定的完整基线 SHA。下面的 `CHECKOUT` 必须是目标项目仓库，不是 `$APP`：

```sh
export CHECKOUT='/目标项目仓库的本地checkout绝对路径'
SHA="$(git -C "$CHECKOUT" rev-parse 'BASE_REF^{commit}')"
test "$(printf %s "$SHA" | wc -c | tr -d ' ')" -eq 40 || { echo '需要完整的40位commit SHA' >&2; exit 1; }
git -C "$CHECKOUT" cat-file -e "$SHA^{commit}"
```

把 `BASE_REF` 换成管理员交付的固定分支或 commit 引用。`SHA` 必须属于 `CHECKOUT` 对应的目标仓库、完整且已在其本地对象库中；编排器不会替你 fetch。若对象不存在，先请管理员确认基线和 checkout，不要用 Sandcastle 应用仓库的 SHA 代替。

### 第四步：提交任务

下面把代码版本、Issue 编号和正文打包为 JSON，再提交。`jq` 会处理正文中的引号和换行，不需要手动转义。CLI 会输出一行 JSON 回执：

```sh
INPUT="$(jq -n --arg sha "$SHA" --argjson issue "$ISSUE" --arg issueBody "$ISSUE_BODY" \
  '{sha:$sha,issue:$issue,issueBody:$issueBody}')"
REPLY="$(pnpm --dir "$APP" exec tsx src/cli.ts submit \
  --socket "$DATA/control.sock" --repo "$REPO_ID" \
  --capability implementation --source manual --input "$INPUT")"
printf '%s\n' "$REPLY" | jq .
```

### 第五步：保存任务编号，查看进度

确认回执为接纳状态并保存 `executionId`。拒绝回执会有 `accepted:false` 和原因；接纳回执中的 `executionId` 才用于查询：

```sh
printf '%s\n' "$REPLY" | jq -e '.accepted == true and (.executionId | type == "string")' >/dev/null || {
  echo '请求未接纳；查看上方 JSON 回执及 reason' >&2
  exit 1
}
EXECUTION_ID="$(printf '%s\n' "$REPLY" | jq -r .executionId)"
printf 'executionId=%s\n' "$EXECUTION_ID"
pnpm --dir "$APP" exec tsx src/cli.ts show "$EXECUTION_ID" --socket "$DATA/control.sock" | jq .
```

`show` 返回的状态在 `.execution.status`；最近一次尝试在 `.attempts[-1]`。先等待队列处理，不要因为尚未完成就重复提交。以下字段结构是示意，不是真人实测输出：

```json
{
  "execution": { "id": "<executionId>", "status": "completed" },
  "attempts": [{
    "kind": "agent",
    "contract": "valid",
    "business": "模型生成的业务报告",
    "toolCalls": [{
      "id": "1",
      "runState": "completed",
      "receipt": {
        "draft": true,
        "url": "https://github.com/OWNER/REPO/pull/123"
      }
    }]
  }]
}
```

实际报告字段以当前记录为准：业务报告通常位于 `.attempts[-1].business`；发布结果在含 `publish_draft` 的工具调用下，成功回执包含 `receipt.url` 与 `receipt.draft`。`completed` 只表示记录的执行入口结束，仍要核对 `contract`、报告和发布回执；只有 Draft PR 链接存在且 `draft` 为 `true` 才进入 PR 审查。

### 第六步：打开并审查 Draft PR

审查 Draft PR 中的改动、测试证据和报告。Sandcastle 不会自动 merge；是否修改、批准或合并由仓库维护流程决定。

## 常见状态

- `queued`：已接纳并排队，尚未开始；可稍后再次 `show` 查询。
- `starting` / `running`：正在准备或运行；等待后再查询，不要重复提交。
- `completed`：入口已结束；检查业务报告、测试结果和 Draft PR 回执，不能只凭此状态判断任务成功。
- `unknown`：执行或外部结果未能确定。停止继续提交和 retry，保留 `executionId` 并联系管理员核查；盲目重试可能重复外部写入。
- 未知状态、拒绝原因不明、服务不可用或没有 Draft 链接：把 `executionId` 与回执交给管理员，不要自行盲目 retry。

管理员负责配置和恢复；需要首次部署、授权边界、故障核查或备份恢复时，请看[部署与运维指南](deployment-guide.md)。

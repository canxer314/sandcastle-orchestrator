# Sandcastle orchestrator

独立的单机 TypeScript 应用。当前交付 [#15](https://github.com/canxer314/sandcastle-orchestrator/issues/15) 的请求提交与查询，不启动业务执行。完整规格见 [#14](https://github.com/canxer314/sandcastle-orchestrator/issues/14)。

## 安装与运行

需要 Linux、Node.js 24+、pnpm 12.3.4 和 util-linux 提供的 `flock`。Sandcastle 固定为 `0.12.0`，Effect 固定为 `3.20.0`，升级需显式更新依赖和锁文件。

```sh
pnpm install --frozen-lockfile
pnpm start serve --data /srv/orchestrator-data --config ./examples/config.ts
```

先修改配置中的 repo 登记和能力定义。配置是管理员部署的可信 TypeScript 代码，启动时加载，不热更新。`version` 填配置仓库的部署 commit，不是任务代码 SHA。输入校验器可以同步或异步执行，以抛出错误或 Promise 拒绝表示拒绝；服务等待校验结束后才保存接纳记录，返回值不会改写原始输入。当前环境登记只校验引用，不创建环境或承诺隔离，`run` 入口不会调用。

运行目录必须专供本应用使用，与配置及目标 checkout 分开，不提交到 Git。启动前检查应用、配置目录和登记的 checkout 路径，拒绝包含关系及符号链接重合，检查失败不修改目录权限。repo 位置当前是本地 checkout 路径。服务将目录权限设为 `0700`，socket 和新建文件设为 `0600`。同一目录只能启动一个控制实例，内核文件锁在服务崩溃后释放。无需也不得通过删除锁文件恢复。

## 提交与查询

CLI 只通过 Unix socket 操作控制服务，服务不可用就失败，不直接打开数据库。所有命令输出 JSON，错误写入 stderr 并返回非零退出码。

```sh
pnpm start submit --socket /srv/orchestrator-data/control.sock \
  --repo example --capability test-commit --input '"abc123"' --source manual

pnpm start list --socket /srv/orchestrator-data/control.sock --repo example --status queued
pnpm start show REQUEST_OR_EXECUTION_ID --socket /srv/orchestrator-data/control.sock
```

`--input` 是 JSON，自由文本用 JSON 字符串提交。`--source` 是来源标识，如 `manual` 或外部定时脚本名称，不能放凭据。

直接调用 socket 时，提交必须包含 `input` 字段。缺少该字段是协议错误，服务返回 HTTP 400 和 `Missing input`，不建立请求或执行。显式 JSON `null` 不是缺失字段，会交给能力校验器，并按普通提交规则保存结果。未知命令返回 HTTP 400 和 `Unknown command`，不会按 `show` 查询记录。

合法提交在同一个 SQLite 事务中保存请求和执行，返回 `accepted: true`、`requestId`、`executionId`。无效 repo、能力或输入在数据库可写时保存拒绝记录，返回 `accepted: false`、`requestId`、`reason`，不建立执行。校验器抛错即拒绝，即使错误消息为空，也不会建立执行。拒绝也是已记录的提交响应，退出码为 0，脚本必须检查 `accepted`。必要保存失败返回非零退出码，不返回接纳或拒绝回执。

`show` 可使用请求或执行标识，包含原始输入、来源、拒绝原因、排队执行和空的尝试列表。`list` 只列执行，按提交顺序返回，可按 repo 和状态筛选。没有去重键功能，相同输入每次提交都是独立请求。所有合法请求保持 `queued`，重启后仍可查询，不会自动消费。

不要在输入或配置里写凭据。服务不主动保存环境变量或认证头，但原始输入和校验错误会持久化，输入、配置和运行记录应当作为敏感数据保护。这不是通用秘密过滤器。

## 验证

```sh
pnpm test
pnpm run typecheck
pnpm audit
```

测试经真实 CLI/socket 启动控制服务，用临时 SQLite 和文件系统验证提交、拒绝、查询、事务失败、服务独占、崩溃恢复和文件权限。没有运行模型、容器或 MCP，也没有验证它们的访问约束。

后续实现沿用这一管理入口，按 #16–#29 增加执行与验收。本版本没有自动恢复、调度、取消、重试、保留清理或备份管理，不应按完整生产规格部署。

# 提交与可靠回执

源码入口是 `pnpm start`，本地 tgz 安装后使用 `sandcastle-orchestrator`。npm/Release 仍未发布。以下命令使用已配置的 repo、capability 或 role ID，不从 cwd 或唯一配置猜目标。repo ID 不是 checkout 路径，source 是来源标识，不是认证身份，不能放凭据。

## JSON 参数、文件或 stdin

三种输入任选一种，只解析 JSON，不执行文件。不新增通用 `--sha`，输入 schema 和固定版本选择由 capability/role 负责。

```sh
pnpm start submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual \
  --input '"0123456789012345678901234567890123456789"'

pnpm start submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual --input-file input.json

cat input.json | pnpm start submit --data /srv/orchestrator-data --human \
  --repo example --capability test-commit --source manual --input-file -
```

使用实际配置中的 ID 和输入替换示例。`--input` 与 `--input-file` 互斥；空输入、非法 JSON、文件读取错误、缺少必要参数和不支持的参数组合都在发请求前退出 1。新模式/选项严格拒绝额外位置参数、无关参数和 offline 写入。`--scheduled-at` 仍只是元数据，不是启动计时器。

管理命令默认 JSON，不按 TTY 切换；显式 `--human` 与 `--json` 互斥。JSON stdout 只包含机器结果，诊断和进度在 stderr。`serve` 保留 stdout ready JSON 和 stderr 服务日志，拒绝 `--human`。旧调用不使用新选项时保留参数容忍、等待和退出码，包括 `accepted:false` 仍为 0。JSON 文件/stdin 提交也不自动补 key，不增加 human 等待上限。

## 接纳不等于执行成功

submit 仍异步，只等待接纳回执，不等待执行，不自动启动服务。human 回执给出实际 request/execution ID 及下一条 show 命令；拒绝回执显示实际 request ID 和原因，退出 1，不伪造 execution ID。相同 source/key 的相同提交可能返回原 execution ID，接纳不代表创建了新执行。键内容冲突是明确错误，不应更换 key 后盲目重发。

`submit --human` 未给 `--deduplication-key` 时，每次独立调用生成一个新 key。在发出请求前，将 source、key 和可执行只读查证命令写到 stderr。显式 key 原样使用，JSON 不生成 key。同一次调用不会自动重发。保留 stderr 提示，尤其是尚未拿到 execution ID 时。

查询及新模式/选项写命令默认使用所选 `--data/control.sock`，data 默认 `~/.sandcastle-orchestrator/data`。显式 socket 优先；同时显式给 data/socket 时必须对应同一物理 socket，符号链接别名可用。相对路径按 cwd 解析，不加载配置猜 socket。旧写调用仍须 `--socket`。提示命令保留本次 data/socket，不会悄悄查询默认实例。连接失败时，先核对目标实例，再显式使用自己的 data 和可信 config 启动 serve；客户端不会代为启动。

## 回执不确定时只读核对

human 写操作最多等待 30 秒，包括持续接收响应的时间，只限制客户端。断线、超时、无法确认的回执或 Ctrl+C 都不会撤销操作，也不会自动重发。

| 情况 | 退出码 |
| --- | --- |
| human 已确认成功回执 | 0 |
| human 明确拒绝、连接未成功或普通错误 | 1 |
| human 已发出写操作，结果未确认 | 2 |
| human 在发送前中断客户端等待 | 130 |
| 旧 JSON 接纳或拒绝回执 | 0，必须检查 `accepted` |

2 优先于中断状态。日常 Ctrl+C 只停止客户端等待，不自动 cancel。查询中断为 130；查询到 failed 或 unknown 仍为查询成功 0，详见[查询与离线查证](queries.md)。

submit 回执丢失时，使用发送前保存的 source/key 和原实例，只读核对全部请求。用实际值替换占位符：

```sh
pnpm start show --source SOURCE --deduplication-key KEY --data /srv/orchestrator-data --human
pnpm start show --source SOURCE --deduplication-key KEY --data /srv/orchestrator-data --offline --human
```

source/key 查证会包含拒绝与接纳记录。没有匹配只表示尚未查到记录，不证明可以安全重发。离线命令必须使用已知对应的 data，不能从任意自定义 socket 位置猜 data，也不能携带 `--socket`。不要只为查记录而启动可能调度历史任务的服务。保留现场，按实际进程、容器及外部副作用人工核对。

## 其他管理写命令

`cancel`、`confirm-stop`、`resolve`、`retry`、`cleanup`、`pause`、`resume`、`restore-review` 均支持 `--human`，与 submit 使用相同的客户端等待及退出码规则。原审计字段、人工停止确认和恢复限制不变。每个命令的必填字段见 `pnpm start COMMAND --help`。

```sh
pnpm start cancel EXECUTION_ID --data /srv/orchestrator-data --human --reason 'operator requested stop'
pnpm start pause --data /srv/orchestrator-data --human --source operator --reason 'backup window'
pnpm start cleanup --data /srv/orchestrator-data --human
```

cancel 回执只证明取消请求已接纳，不证明执行已停止。confirm-stop 只记录人工独立核对结果，不负责停止进程；resolve/retry 仍要求停止证据和外部结果审查，retry 不等于恢复旧工具位置。pause 不停止已有执行，restore-review 不自动 resume。cleanup 回执保留每项清理状态和原因，不能把 partial 或 unknown 当作全部清理成功。

无提交 source/key 的管理写操作不虚构 key。回执未确认时，按已知 ID 给 show 指引；pause/resume/restore-review 给 maintenance，cleanup 给 list，均保留同实例选择。cleanup 的 list 仅用于定位执行，需再查 show/logs 的实际证据与清理状态。

本增量使用真实 CLI 子进程、Unix socket、控制服务和受控故障响应测试；不改变持久化记录或 socket 协议。正式 tgz 交叉验收留给集成阶段。真实 Docker、真实模型、私人连接及生产外部写入均未在本增量验收，不以受控测试代替。

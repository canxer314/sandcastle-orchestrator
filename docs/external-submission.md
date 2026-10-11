# 外部定时提交

外部定时设施只负责触发提交；服务仍通过本机 CLI/socket 接纳和查询。安装依赖后，用固定 JSON 文件描述要提交的内容，不能在每次触发时重新解析 SHA、分支或动态范围：重送必须保持请求内容不变。

```json
{
  "repo": "example",
  "capability": "test-commit",
  "input": "abc123",
  "source": "nightly-test"
}
```

保存为管理员维护的 `/etc/sandcastle/nightly-test.json`，再由 cron、systemd timer 或普通脚本运行：

```sh
node --import tsx examples/external-submission.ts \
  --socket /srv/orchestrator-data/control.sock \
  --file /etc/sandcastle/nightly-test.json \
  --task nightly-test \
  --scheduled-at 2026-10-11T02:00:00.000Z
```

`--task` 是稳定且显式的任务标识，`--scheduled-at` 是这次预定触发时间。脚本根据两者构造去重键，并把计划时间和提交 JSON 一起交给现有 `submit` CLI；同一次触发重送时必须使用相同参数及同一份文件。若 SHA、范围或其他输入发生变化，应当明确创建新触发标识/计划时间，不得让重送时的“最新”值悄悄改变旧请求。`source` 是 `list --source` 可查询的来源范围。

脚本接纳成功时输出 JSON 回执。内容校验拒绝、同键内容冲突、CLI 或 socket 失败都会写入 stderr 并以非零状态退出；调度器应监控退出码，不能把拒绝当成成功。成功的重复提交会返回已有请求和执行，不产生第二条记录。已接纳工作未结束时，新计划触发仍会被接纳；去重键不是重叠锁，也不取消或替换旧工作。

## 定时器语义

定时设施应配置为不逐次补跑停机期间错过的触发。服务和脚本不会推导缺失的计划，也不会自动补跑。需要补跑时，管理员应明确选择任务及时间/输入范围，使用单独、明确的触发时间或标识提交；不要把已接纳工作的重试误认为补跑。

cron 和 systemd timer 的默认行为通常不为每个错过的周期逐次触发。本例显式使用 `Persistent=false`。`Persistent=true` 会在恢复后补触发一次错过的日历事件，并不是逐次回放，但这里也不默认启用；cron 重启后不会遍历错过的每次任务。任何外部包装器都应保持这一语义，避免自行追补整段停机时间。

不要用“先查是否运行、再提交”防止重叠，这存在竞争窗口。确实要求防重叠时，由有该需求的外部设施承担互斥；本脚本不提供锁。

## 部署与权限

在控制服务主机上安装固定版本的应用依赖并运行脚本。调度账号只应获得运行 Node、读取固定提交文件及配置、访问控制 socket 所需的最小权限；socket 权限由服务控制。提交文件和输入记录可能包含敏感数据，不要写入凭据，按敏感配置保护文件和日志。不要给脚本授予目标仓库之外的额外权限，也不要以 root 运行，除非部署本身确有必要。

去重只抑制同一来源范围内同键、同内容的重复接纳；同键异内容是冲突。不同计划时间/任务标识会创建独立请求。此机制不保证能力产生的外部副作用幂等；能力本身仍需按业务需要处理重复执行。

该提交入口不改变旧请求记录。没有去重键的旧 CLI 调用仍按原规则每次创建新请求；既有记录仍可查询，计划时间和去重键仅适用于通过新参数提交的请求。

## cron 配置示例

下例每晚 02:00 UTC 提交一次。计划时间取本次触发的 UTC 日期和固定 02:00 时点；明确重送时使用当时保存的时间，不重新运行 `date`。

```cron
CRON_TZ=UTC
0 2 * * * cd /opt/sandcastle-orchestrator && node --import tsx examples/external-submission.ts --socket /srv/orchestrator-data/control.sock --file /etc/sandcastle/nightly-test.json --task nightly-test --scheduled-at "$(date -u +\%Y-\%m-\%d)T02:00:00Z"
```

确认所用 cron 支持 `CRON_TZ`；否则将主机/cron 时区设为 UTC。cron 中的 `%` 需要转义。该例不启用自动重送，失败后由管理员携原计划时间及原 JSON 文件明确重送。

## systemd 配置示例

服务单元 `/etc/systemd/system/orchestrator-nightly.service`：

```ini
[Service]
Type=oneshot
User=orchestrator
WorkingDirectory=/opt/sandcastle-orchestrator
ExecStart=/bin/sh -c 'exec /usr/bin/node --import tsx examples/external-submission.ts --socket /srv/orchestrator-data/control.sock --file /etc/sandcastle/nightly-test.json --task nightly-test --scheduled-at "$(date -u +%%Y-%%m-%%d)T02:00:00Z"'
```

定时单元 `/etc/systemd/system/orchestrator-nightly.timer`：

```ini
[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=false
AccuracySec=1s
Unit=orchestrator-nightly.service

[Install]
WantedBy=timers.target
```

管理员检查路径和账号后执行 `systemctl daemon-reload`、`systemctl enable --now orchestrator-nightly.timer`。systemd 单元内 `%` 要写成 `%%`。此例固定日历时点，不配置自动重启/重送，错过整天不补跑；跨日异常延迟时应人工核对计划日期。需要可靠重送的外部设施应保存触发时间和输入快照，不重新计算。

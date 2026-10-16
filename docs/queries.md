# 查询与离线查证

本页是日常查询参考。先按[主教程](user-guide.md)提交只读模块分析，再带相同 data 和真实编号查询。0.1.0 已发布，安装用户使用正式命令，不需要源码或 pnpm。show、list、logs 支持在线与离线查询，artifact、maintenance 仅支持在线查询。

## 选择实例与输出

查询默认 JSON，不随 TTY 改变。显式 `--human` 才输出可读格式，与 `--json` 互斥。新选项严格拒绝额外位置参数和无关参数；不使用新选项的旧调用仍保留既有容忍行为。管理写命令的 human 回执和文件/stdin 输入见[提交与可靠回执](submissions.md)。`serve --human` 明确拒绝，ready JSON 与 stderr 服务日志不变。

查询未指定 socket 时使用所选 `--data` 内的 `control.sock`，默认 data 为 `~/.sandcastle-orchestrator/data`。显式 `--socket` 优先；同时显式给 data 时，必须指向该 data 的同一个物理 socket，符号链接别名可用。相对路径按当前目录解析。查询不会为了猜 socket 加载 `--config`，也不会启动服务。使用新模式/选项的写命令沿用上述实例选择；旧写调用仍须显式提供 `--socket`。

```sh
sandcastle-orchestrator list --data /srv/orchestrator-data --human
sandcastle-orchestrator show EXECUTION_ID --data /srv/orchestrator-data --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --attempt ATTEMPT_ID --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --attempt ATTEMPT_ID --call 1 --human
sandcastle-orchestrator artifact EXECUTION_ID --data /srv/orchestrator-data --name report.txt --human
sandcastle-orchestrator maintenance --data /srv/orchestrator-data --human
```

用实际返回的编号替换占位符。`show` 分开展示接纳、执行状态、实际 attempt、业务原文或结果引用与证据缺口。`completed` 或任意 `passed` 字段不构成通用业务成功判断。`list` 只列有关联执行的记录，带 repo、状态和待核对提示。`logs` 默认最新 attempt，保留 attempt/call 选择、缺失、清理、截断和完整性信息。每个日志流最多返回末尾 64 KiB。artifact 保留原 base64 内容和分段元数据，不自动解码或声称产物完整。

human socket 查询最多等待 30 秒，包含接收响应的时间。超时退出 1，可用同一实例和编号重新查询。Ctrl+C 退出 130，只停止客户端等待，不取消执行。查询成功为 0，即使查到业务失败或 unknown；普通读取或协议错误为 1。旧 JSON 的等待规则和退出码不变。

## 丢失回执时按来源与键查证

```sh
sandcastle-orchestrator show --source webhook --deduplication-key delivery-1 --data /srv/orchestrator-data --human
sandcastle-orchestrator show --source webhook --deduplication-key delivery-1 --data /srv/orchestrator-data --offline
```

source 与 key 必须成对提供，不能同时给请求或执行编号。JSON 始终为数组，即使只有一项。每项包含 `accepted`、`request`、`execution`、`attempts`，按请求记录顺序返回全部匹配项，含拒绝记录。拒绝不占接受去重键，同组可能先拒绝多次再接纳。按编号的旧响应仍只有 `request`、`execution`、`attempts`。

空数组只说明尚未查到受理记录，不证明可以安全重发。查询不会调用 submit，也不会自动重发。source 不是认证身份。

## 离线读取现有证据

```sh
sandcastle-orchestrator show EXECUTION_ID --data /srv/orchestrator-data --offline --human
sandcastle-orchestrator list --data /srv/orchestrator-data --offline --human
sandcastle-orchestrator logs EXECUTION_ID --data /srv/orchestrator-data --offline --human
```

`--offline` 仅支持 show/list/logs，与显式 socket 冲突。默认仍输出 JSON。它只读 `DATA/records.sqlite` 和所选日志，不加载 TypeScript 配置、不依赖 init 标记、不创建目录/库/表、不迁移、不补标记、不写状态，也不启动服务。缺失或不支持的记录结构明确报错，保留原件；读取错误不等于数据损坏。

支持当前既有 requests、executions、attempts、submission_metadata、execution_management 表结构和 DELETE journal 模式。不要求 maintenance 或接受去重映射表。缺少查询所需表的更旧数据明确拒绝，离线不会执行在线启动时的兼容补表。WAL 或非空 journal 会拒绝读取，避免创建共享内存或触发恢复、忽略尚未合入主文件的记录。不要删除 sidecar 绕过错误，保留现场并交由管理员核对。

离线 starting/running 只是最后持久化状态，当前活动未核实。对应 attempt 的 JSON 带 `activityVerified: false`，不会回写 unknown，也不宣称仍运行或已经停止。在线启动后的 unknown 投影和既有人为停止确认、审计、恢复含义保持不变。

SQLite 只读事务保证数据库查询的一致视图，不冻结外部日志；并发清理、写入或文件缺失仍可能使证据不完整。离线产物查询未提供，业务结果引用可用于人工定位保留文件。不要只为看结果而启动可能调度遗留任务的服务；先核对实际进程、容器与外部副作用，再按既有维护/恢复流程处理。

查询返回已有记录，不检查模型认证、容器当前活动或生产外部结果。受控 CLI/socket 测试不替代真实 provider 验证；离线结果尤其不能证明仍在运行或已经停止。

## 阅读只读模块报告

setup 生成入口的 `show --human` 直接显示可读报告，或给出大结果引用。完整原文在实际 attempt 的 `artifacts/report.txt`，以实际 location 为准，不要猜编号。核对实际 SHA、问题、文件引用与缺失证据；非空文本的 `contract: valid` 不保证答案正确。它没有执行测试，不能据报告自述宣称测试通过。

`artifact` 即使加 `--human` 也保留 base64 与分段信息。下面读取完整的小报告，核对可用性后解码，不执行报告内容。未指定 offset 时，成功响应直接包含全文，不带 complete 字段：

```sh
sandcastle-orchestrator artifact EXECUTION_ID --data /actual/project/data --name report.txt |
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s);if(r.availability!=="available"||r.encoding!=="base64"||typeof r.content!=="string")throw Error("Report unavailable; inspect show and artifact response");process.stdout.write(Buffer.from(r.content,"base64"));});'
```

产物默认上限 8 MiB。超限时用 `--offset 0`，按 `nextOffset` 逐块查询到 `complete:true`，不能把首块当完整原文。多次尝试用 `--attempt ATTEMPT_ID` 选择对应日志或产物；大业务结果可通过 `businessReference` 指向的 `business.json` 读取。

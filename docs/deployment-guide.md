# 部署、维护与备份

面向管理单机实例的维护者。首次安装见[安装与演示](installation.md)，真实项目分析见[用户指南](user-guide.md)，新增角色和工具见[扩展教程](readonly-role-tutorial.md)。本页负责实例权限、上线、额度、升级、备份、恢复、通知与清理。

## 准备独立实例和可信配置

源码构建与发布步骤见 [CONTRIBUTING.md](../CONTRIBUTING.md)。Sandcastle 固定为 `0.12.0`，Effect 固定为 `3.20.0`，升级需显式更新依赖和锁文件。以下示例显式选择可信配置：

```sh
sandcastle-orchestrator serve --data /srv/orchestrator-data --config /srv/orchestrator-config/config.ts
```

先修改配置中的 repo 登记和能力定义。配置是管理员部署的可信 TypeScript 代码，启动时加载，不热更新。`version` 填配置仓库的部署 commit，不是任务代码 SHA。输入校验器可以同步或异步执行，以抛出错误或 Promise 拒绝表示拒绝；服务等待校验结束后才保存接纳记录。服务在校验前保存原始输入快照，校验器的返回值或原地修改均不改写接纳或拒绝记录中的输入。旧配置仍有效，没有 `execution` 的能力只接纳排队，不调用 `run`。明确配置 `execution.commit(input)` 和对应环境的 `docker.image` 后，只有新提交或显式 retry 自动执行；历史确定性排队请求不因重启或后来启用执行配置而自动启动。不完整执行配置拒绝启动服务。示例能力要求完整 SHA，业务脚本为目标 commit 中的 `test.sh`。

运行目录必须专供本应用使用，与配置及目标 checkout 分开，不提交到 Git。启动前检查应用、配置目录和登记的 checkout 路径，拒绝包含关系及符号链接重合，检查失败不修改目录权限。repo 位置当前是本地 checkout 路径。服务将目录权限设为 `0700`，socket 和新建文件设为 `0600`。同一目录只能启动一个控制实例，内核文件锁在服务崩溃后释放。无需也不得通过删除锁文件恢复。

## 最小外部可信配置

创建彼此独立的配置、data、checkout 和安装目录。以下例子只提供提交/查询，故意不配置 execution，不调用 Docker 或模型。`run` 不会执行，接纳的请求保持 queued。

```sh
set -eu
CONFIG="$HOME/.config/sandcastle-orchestrator"
DATA="$HOME/.local/state/sandcastle-orchestrator"
mkdir -p "$(dirname "$CONFIG")"
mkdir -m 700 "$CONFIG"
printf '%s\n' '{"private":true,"type":"module"}' > "$CONFIG/package.json"
# mkdir 遇到已有目录就停止；已有配置请手工合并，不运行下面的覆盖写入。
cat > "$CONFIG/config.ts" <<'TS'
export default {
  version: 'replace-with-deployed-config-commit',
  repos: [{ id: 'example', location: '/absolute/path/to/your/checkout' }],
  environments: [{ id: 'local' }],
  capabilities: [{
    id: 'accept-only',
    environment: 'local',
    validate(input: unknown) {
      if (typeof input !== 'string') throw Error('Expected text');
    },
    run() { throw Error('No execution configured'); },
  }],
};
TS
sandcastle-orchestrator serve --config "$CONFIG/config.ts" --data "$DATA"
```

上面的创建示例只适用于新的配置目录；已有文件请手工合并。另开终端，使用相同 DATA：

```sh
DATA="$HOME/.local/state/sandcastle-orchestrator"
sandcastle-orchestrator submit --socket "$DATA/control.sock" \
  --repo example --capability accept-only --input '"hello"' --source manual
sandcastle-orchestrator list --socket "$DATA/control.sock"
sandcastle-orchestrator show EXECUTION_ID --socket "$DATA/control.sock"
```

`EXECUTION_ID` 替换为回执中的编号。接纳不等于完成。管理命令仍默认 JSON；拒绝提交仍是 exit 0 的已记录响应，必须检查 `accepted`；参数、传输及服务错误为非零退出。serve 的 stdout 保留 ready JSON，stderr 保留安全服务日志。退出控制服务不证明已有容器或 Agent 停止。

配置是管理员授权执行的 TypeScript，不是沙箱数据。加载和校验都可能执行配置及其 import 的任意代码，不能称为完全无副作用。配置依旧由 tsx 加载，支持原有 TypeScript 转换及相对 `.js` import 到 `.ts` 文件的解析，不依赖 Node 原生类型擦除。推荐显式 ESM `package.json`；旧的无 ESM 声明配置仍保留兼容。相对 CLI 路径按当前 cwd 解析，不向上搜索配置。data 与应用安装根、配置目录、配置 symlink 的真实目录及登记 checkout 必须物理分离，双向包含与 symlink 重合都拒绝。

## 登记实际仓库和执行环境

1. 先确认授权范围和本地 checkout。`repos[].location` 必须是本机 Git checkout；checkout、配置目录和专用 `$DATA` 不要相互包含。确保服务运行用户只得到预期的 repo 读权限。
2. 在受信配置的 `repos` 登记稳定 ID 与绝对 checkout 路径；为该 repo 添加实际要用的 capability/environment。配置 `version` 记部署配置版本，不填任务 SHA。
3. 先用完整 commit SHA 手工 submit。编排器会从本地 repo 导出该 commit 的内容；它不会替你 fetch，也不会带入未提交更改、remote、`.git` 或 hooks。当前拒绝 symlink/submodule，且单个 blob 上限 64 MiB。先确认 SHA 在本地对象库中存在。
4. 执行 capability 使用预先部署的可信镜像，不能把仓库里的任意脚本或依赖安装当成可信。Docker 执行无网络、`--pull=never`、只挂载尝试代码及产物，镜像不会自动清洗；管理员负责镜像来源、UID/GID 兼容和其中依赖。没有真实 Docker 授权时只跑受控测试，不要以测试替身冒充容器验收。

## 设置主 Agent 额度与排队

配置顶层可选 `primaryAgentLimit` 设置全局主 Agent 上限，`repos` 的同名字段设置该 repo 上限，均须为正安全整数。省略全局字段不设全局上限，省略 repo 字段默认串行，旧配置无需修改。配置只在启动时加载，降低额度不会停止已有尝试，新请求等待占用降到额度以下。

```ts
primaryAgentLimit: 4,
repos: [
  { id: 'alpha', location: '/srv/repos/alpha' }, // 默认 1
  { id: 'beta', location: '/srv/repos/beta', primaryAgentLimit: 2 },
],
```

控制服务按已持久化的提交顺序扫描最早可启动请求，可跳过额度已满的 repo。尝试保存成功、进入 `starting` 即占位，包括环境准备；保存失败不开始实际执行。启动中、运行中、未知及停止未确认的主 Agent 保留额度，重启不会释放。可信结束或恢复者 `confirm-stop` 确认后可调度等待请求，单独发送取消不释放。未知记录中的停止确认仍保留供后续 `resolve`/`retry` 核对，不要求先重试才释放额度。

独立确定性执行不占主 Agent 额度，也不因主 Agent 满额等待，仍须保存成功并确认旧尝试停止。内部工具/MCP 与 Agent 自派子 Agent 不另排队、登记或占额。额度不保证总进程数、模型调用数、成本或全机资源；没有优先级、抢占、分布式租约或等待时长保证。

## 维护窗口、备份与恢复

安装、卸载和换版的资源保留及手工操作步骤见本页[资源保留与手工换版](#资源保留与手工换版)。包管理器不能发现所有服务实例，也不会替你暂停或停止服务。

管理入口新增 `maintenance` 查询，`pause`／`resume --target admission|starts|all`（默认 all），均要求 `--source`、`--reason`。暂停状态及操作历史保存在 SQLite，重启不自动恢复。`serve --maintenance paused` 在首次 dispatch 前暂停接纳与启动；恢复旧备份必须使用 `serve --maintenance restore`，每次建立新的核对门槛。暂停启动不暂停或 kill 已有 attempt，也不表示它已停止。查询、协作取消和人工核对仍可用；优先等待 `list/show` 中执行可信结束，不能等时用现有 `cancel`、`confirm-stop`、`resolve`，未确认停止仍为 unknown，不释放额度、不替代执行。不要关闭 harness 或容器制造结束。

```sh
sandcastle-orchestrator pause --socket "$DATA/control.sock" --target all --source operator --reason 'pre-upgrade backup'
sandcastle-orchestrator maintenance --socket "$DATA/control.sock"
sandcastle-orchestrator list --socket "$DATA/control.sock"
```

人工确认没有运行中或未确认的外部执行后，停止控制服务（只发 SIGTERM 给控制进程，不发给 harness），用主机工具做一致的离线备份。不能只复制在线 SQLite 主文件；若无法静止全部写入，使用 SQLite `.backup` 获得数据库快照，但日志和产物仍需单独保证一致。暂停不冻结日志，备份时不要运行 cleanup。下面是离线备份示例，`DATA`、`CONFIG_DIR`、`BACKUP` 是管理员指定、互不包含的绝对目录；配置依赖文件也应位于 CONFIG_DIR。凭据保留现有主机 secret 管理，不把环境、token、连接串写入记录或示例备份。备份目录应在独立磁盘或现有受保护的异机备份系统，示例临时磁盘不是灾备。

```sh
set -eu
umask 077
mkdir -m 700 "$BACKUP"
date -u +%FT%TZ > "$BACKUP/backup-point.txt"
sqlite3 "$DATA/records.sqlite" ".backup '$BACKUP/records.sqlite'"
test "$(sqlite3 "$BACKUP/records.sqlite" 'PRAGMA integrity_check;')" = ok
tar --exclude=control.sock --exclude=control.lock --exclude=records.sqlite --exclude=records.sqlite-wal --exclude=records.sqlite-shm -C "$DATA" -cpf "$BACKUP/evidence.tar" .
tar -C "$CONFIG_DIR" -cpf "$BACKUP/config.tar" .
date -u +%FT%TZ > "$BACKUP/backup-completed.txt"
# 保存应用 commit、Node/pnpm 版本和配置 version；独立保存备份开始之后的主机/远端写入审计。
```

如果输入、仓库或配置依赖位于上述目录之外，还须逐项备份并记录原路径与归档的对应关系，包括仓库 `.git` 和未提交修改。所有相关写入者必须已停止，备份位置不能位于源目录内。以下 `INPUT_DIR` 和 `REPO_DIR` 须替换为本实例实际目录，多个资源分别使用尚不存在的归档名：

```sh
set -eu
umask 077
test ! -e "$BACKUP/inputs.tar"
test ! -e "$BACKUP/repository.tar"
tar -C "$INPUT_DIR" -cpf "$BACKUP/inputs.tar" .
tar -C "$REPO_DIR" -cpf "$BACKUP/repository.tar" .
```

恢复这些资源时也使用尚不存在的独立目录，不解包到仍在使用的输入或仓库。先恢复并检查全部资源、配置绝对路径和初始化标记，再启动 restore 服务；有路径冲突先停止，不能凭一次启动成功认定恢复完成。备份含敏感数据，沿用访问控制和加密要求，不额外导出主机秘密。

备份和恢复命令遇到错误立即停止。`BACKUP` 必须是尚不存在的新目录，其父目录须已存在且由管理员保护。`backup-point.txt` 是备份开始时间，也是外部审计核对下界；`backup-completed.txt` 只记录备份完成时间，不用它筛选副作用。跨主机核对还须考虑时钟偏差，保留开始时间之前的必要余量。

实际频率由主机备份任务配置并记录，例如每日 02:00 UTC 加每次升级前；必须按维护窗口暂停、等待和离线一致性要求执行，不能把该示例当作已部署 timer。保留期、加密、异机复制和告警沿用现有主机工具。磁盘损坏最多恢复到可用备份点，不承诺零丢失或无人介入的恢复时间。

升级前保存上述完整备份及旧应用/配置版本；在暂停状态升级依赖/应用，先 typecheck/tests，再启动 `--maintenance paused`，检查 configuration 可加载、`list/show/logs/artifact` 可读并核对已有状态，再明确 resume。本版本新增独立 maintenance 和确定性启动授权表，不修改旧记录和配置格式，旧 socket 命令保持有效。暂停期间明确提交或 retry 的确定性任务会保留启动授权，暂停状态在正常重启后仍保持，须明确 resume 才启动；没有执行配置时接纳的历史 queue 不获得授权，后来启用执行配置也不自动启动。restore 启动原子清除旧备份中的确定性启动授权，核对后不会把这些陈旧 queue 当作新提交执行。旧程序不会执行 maintenance gate，不能用于带待核对备份的正常启动；回退时停服务、恢复匹配的旧备份与配置、核对外部副作用后才启动旧程序。未来格式变化必须单独说明兼容和恢复方案，不能假定旧程序可读新数据；本应用不建设自动迁移/回滚平台，不删除现有迁移和 rollback。

恢复到新建隔离目录，保留故障现场和备份之后的独立审计；不覆盖仍在使用的 data、不复制 socket/lock。两个恢复目录必须尚不存在，父目录须已存在且由管理员保护；解包后核验配置和证据文件权限，根目录保持 `0700`，不要把恢复目录放在共享目录中。恢复配置目录与产物，验证数据库 integrity_check，然后以 restore 模式启动，在任何新执行前核对备份之后的执行、子 Agent、工具、容器及远端写入（数据库缺失的执行也要靠主机/远端审计找回），取消不再适用的旧排队请求，必要时人工确认停止／resolve。不确定就保持暂停。

```sh
set -eu
umask 077
mkdir -m 700 "$RESTORED_DATA" "$RESTORED_CONFIG"
cp "$BACKUP/records.sqlite" "$RESTORED_DATA/records.sqlite"
tar -C "$RESTORED_DATA" -xpf "$BACKUP/evidence.tar"
tar -C "$RESTORED_CONFIG" -xpf "$BACKUP/config.tar"
chmod 700 "$RESTORED_DATA" "$RESTORED_CONFIG"
test "$(sqlite3 "$RESTORED_DATA/records.sqlite" 'PRAGMA integrity_check;')" = ok
sandcastle-orchestrator serve --data "$RESTORED_DATA" --config "$RESTORED_CONFIG/config.ts" --maintenance restore
# 在另一个终端检查 list/show/logs/artifact、配置版本和独立外部审计。
sandcastle-orchestrator restore-review --socket "$RESTORED_DATA/control.sock" --source operator \
  --reason 'post-backup audit compared' --backup-point "$(cat "$BACKUP/backup-point.txt")" \
  --handling 'stale queue cancelled; unknown executions reconciled' --external-results 'host and remote audit checked; describe actual results'
sandcastle-orchestrator resume --socket "$RESTORED_DATA/control.sock" --source operator --reason 'review accepted'
```

`restore-review` 要求接纳和启动都暂停，要求 backup-point、handling、external-results 非空；它保存人工核对，不验证操作者描述的真实性，也不自动 resume。未记录核对前拒绝 resume。恢复无法自动检测，操作者必须使用 restore 启动模式。核对后排队 Agent 在显式恢复时按现有 quota 启动，操作者须先取消不再适用的队列。无启动授权的历史确定性 queue 保持原有不自动执行规则；queued 状态不能 retry，需要先取消并核对副作用，再明确 retry。每次演练记录实际频率配置、快照时间、恢复耗时、验证项和介入条件；真实模型/容器与部署验收另行授权。


## 资源保留与手工换版

安装、卸载、重装和换版只替换 CLI 程序。npm 不知道你的服务在哪些终端或进程管理器下运行，也不会替你暂停或停止服务。它不会加载配置、迁移数据库、启动或重启服务；安装/卸载也不清理其他目录。

升级前先确定这一个实例的所有实际路径，不要只依赖默认目录或包管理器。需要纳入保留清单的有：配置文件及其 `import` 的依赖、完整 data（包括 `init.json`、SQLite、`attempts/`、日志和产物）、外置任务输入、setup 或 demo 建立的资源、演示及真实 Git 仓库和任何自定义数据路径。安装 prefix 与这些资源分开。包管理器无法发现全部实例，也不会替你找自定义路径。

先让该实例暂停接纳和启动，保留队列：

```sh
DATA='/absolute/path/to/this-instance/data'
sandcastle-orchestrator pause --socket "$DATA/control.sock" --target all \
  --source operator --reason 'pre-upgrade'
sandcastle-orchestrator maintenance --socket "$DATA/control.sock"
sandcastle-orchestrator list --socket "$DATA/control.sock"
```

等每个执行在可信记录中结束。不能等待时，使用现有 `cancel` 协作取消，并逐一核实执行入口、Agent、工具和容器确已停止，再按现有流程记录 `confirm-stop`/`resolve`。状态为 `unknown` 或有待核对事项时，先核对并保留现场，不得继续换版。控制服务收到 SIGINT/SIGTERM 后退出，不证明执行或容器已经停止；也不要关闭 harness 或容器来制造结束证据。

确认没有运行中或待核对执行后，停止控制服务。按本页[维护窗口、备份与恢复](#维护窗口备份与恢复)制作完整一致备份，补齐所有外置配置依赖、输入、仓库、setup/demo 资源和路径清单。备份期间停止所有相关写入者，不运行 cleanup。

程序版本可用以下方式更换。省略版本号安装 npm 当前 `latest` 稳定版；固定版本及备用附件示例使用已发布的 0.1.0。换版前仍需完成上面的暂停、核对与备份。
```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
# 最新稳定版
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
# 或固定到已发布的实际版本
npm install --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator@0.1.0
# 或安装从该版本 Release 下载的同一 tgz
npm install --global --prefix "$PREFIX" ./canxer314-sandcastle-orchestrator-0.1.0.tgz
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
```

回退不是单纯安装旧包。若新版本已写入数据，仍先暂停接纳和启动，核实执行已可信结束或停止，再停止控制服务，把与旧程序匹配的配置和完整备份恢复到独立目录，原目录和备份都保留。只有已验证支持的配置/记录 fixture 和明确的 revision 范围可视为兼容；配置 `version` 是部署版本，`init.json` 标记描述初始化布局，数据库结构又是另一回事。项目不增加数据库版本平台，不承诺任意旧程序能读取新版数据。没有格式迁移时无需重新 `init`，不要用新模板覆盖配置。

在新版本上先暂停启动检查，确认程序与原有配置、数据相互匹配：

```sh
sandcastle-orchestrator serve --config "$CONFIG/config.ts" --data "$DATA" --maintenance paused
```

服务启动后另开终端检查 `maintenance`、`list`、`show`、`logs` 和 `artifact`，核对配置及数据；确认完成后，才显式恢复：

```sh
sandcastle-orchestrator resume --socket "$DATA/control.sock" --target all \
  --source operator --reason 'configuration and retained evidence checked'
```

恢复旧备份必须使用本页的 restore 流程，不能用普通 paused 启动替代。备份后的模型调用、代码写入及其他远端副作用不会因数据库回退撤销，需从独立审计核对。没有维护/审核门槛的历史程序不在该恢复流程的支持范围。

卸载只移除 npm 管理的程序：

```sh
npm uninstall --global --prefix "$PREFIX" @canxer314/sandcastle-orchestrator
```

卸载不会删除配置、完整 data、初始化标记、输入、演示或真实仓库、attempt 目录、日志、产物、镜像和证据容器，也不修改 harness 或 CC-Switch。不要运行笼统的递归删除命令。若确需删除资源，先按实际路径逐项确认没有运行或待核对执行，再按组织的数据保留规则手工处理；npm 不会扫描或清理自定义路径。现有 `cleanup` 边界不变；`init --reset-demo` 仅在明确确认后重建演示仓库，不能用于升级配置、清空 data 或 purge；有服务占用或未确认停止的执行时拒绝操作。

配置 `version`、初始化布局版本与数据库结构不是同一种版本。换版须保留既有补表、迁移和恢复兼容路径；已支持的 fixture 与 revision 范围以对应测试为准，范围之外未验收。此处不新增 backup、rollback、purge 或自动迁移命令。

## 故障定位与外部通知

沿用 CLI/socket，不提供监控平台。先按 repo 和状态查询，再用 executionId 查详情。`start_failed` 是启动失败，`unknown` 需要人工核对；`completed` 也可能带 `contract: error`，不能只查状态判断业务结果。业务失败由能力的 `business` 契约解释，通用查询不会猜测业务字段。提交前的校验拒绝不在 `list` 中，使用提交回执的 requestId 查 `show`。

```sh
sandcastle-orchestrator list --socket "$DATA/control.sock" --repo example --status unknown
sandcastle-orchestrator list --socket "$DATA/control.sock" --repo example --status start_failed
sandcastle-orchestrator show "$EXECUTION_ID" --socket "$DATA/control.sock"
sandcastle-orchestrator logs "$EXECUTION_ID" --socket "$DATA/control.sock" --attempt "$ATTEMPT_ID"
node --import tsx examples/query-attention.ts --socket "$DATA/control.sock" --repo example
```

`examples/query-attention.ts` 是只读外部脚本，调用现有 CLI 的 `list` JSON。成功输出单行 `{version:1,available:true,items:[...]}`，退出码 0，无待处理项时 `items:[]`。每项只含 `requestId/executionId/status/attemptId/reasons`，不转发 repo 名称、输入、错误文字、日志、环境变量、business 或人工处理文字。`reasons` 是 `failed`、`needs_attention`、`stop_unconfirmed` 的组合。脚本检查启动失败、契约错误、unknown/必要保存失败以及有取消意图但没有停止确认的尝试；正常 queued、静默 running 不告警，排队取消没有底层尝试也不算未确认停止。无尝试的启动前失败仍显示 `start_failed`，对应 `execution_failure` 服务日志。`execution.startFailures` 在现有管理 JSON 中保留每次失败的 `recordedAt/configVersion/classification/reason/logEvent`，不保存任意异常文字；重启和人工 retry 都保留历史，没有该字段的旧记录仍有效。日志按 executionId、事件和时间查 journal；可核查配置后人工 retry。脚本查询有 30 秒超时及 16 MiB 输出上限，只约束查询，不约束执行。socket 不可用、CLI 失败、输出解析失败或达到上限，stdout 为空，stderr 单行 `{version:1,available:false,error:"Control query failed"}`，退出码 1。不能把失败当成正常的空列表。

详情提供原始请求、尝试、配置版本、实际/选定 SHA、时间、失败原因、日志/产物引用及人工核对的外部结果。原始输入、日志、模型报告和外部结果可能敏感，只在受限环境查看。管理员按能力所用设施核对远端结果，不从模型文字推断成功。`location.container` 可用于 `docker inspect --format '{{json .State}}' NAME` 和 `docker logs NAME`；`processIdentity/reconnectHandle:null` 表示没有可靠宿主进程身份或重连句柄，不能用猜测的 PID 杀进程。名称是定位信息，不是停止证明。还需核对宿主入口、子 Agent、工具和远端操作。控制服务或主 Agent 退出、取消回执、单个容器退出都不证明全部停止。

服务日志写 stderr，交给 systemd journal 或现有日志采集设施。JSON 包含 `time/event/error`，后台执行错误另含 executionId。事件有 `service_failure`、`service_crash`、`execution_failure`、`execution_failure_save_failed`、`management_failure`。服务日志只记录固定安全错误摘要，不写任意异常消息、stack、认证头或完整环境。已知启动校验错误保留安全分类，其他异常显示 `Control service failed`，管理员结合配置部署版本、journal 时间和受限运行记录定位。失败记账本身失败时服务日志仍有证据，但数据库可能暂留 queued，不能仅凭查询宣称没有故障。SIGKILL、断电无法由被杀进程写日志，由进程管理器的退出记录发现。

可由 cron/systemd timer 在应用安装目录运行查询。通知桥只接收上述摘要，渠道凭据由管理员放在桥自己的受限文件中，不写命令参数或通知内容。以下接法要求 `jq` 和管理员现有的 `notify-summary` 工具，不附带发送实现，也不运行真实通知。

```sh
umask 077
summary=$(mktemp)
trap 'rm -f "$summary"' EXIT
if node --import tsx examples/query-attention.ts --socket "$DATA/control.sock" >"$summary"; then
  count=$(jq -er 'if .version == 1 and .available == true and (.items | type == "array") then (.items | length) else error("invalid query summary") end' "$summary") || {
    echo 'query summary validation unavailable or invalid' >&2
    exit 1
  }
  case "$count" in ''|*[!0-9]*) echo 'invalid item count' >&2; exit 1;; esac
  if [ "$count" -gt 0 ]; then
    notify-summary <"$summary" || { echo 'notification channel unavailable' >&2; exit 1; }
  fi
else
  printf '%s\n' '{"version":1,"available":false,"error":"Control query failed"}' |
    notify-summary || { echo 'notification channel unavailable' >&2; exit 1; }
  exit 1
fi
```

没有配置通知就由管理员主动查询并查看 journal，不承诺及时提醒。通知渠道、jq、timer 或进程管理器不可用时，脚本不能补上这些设施；没有心跳、告警升级、自动重试或自动对账。用 `systemctl status UNIT`、`journalctl -u UNIT` 发现控制进程退出，并通过现有 `OnFailure=` 接管理员通知工具。不要配置自动强杀残留来腾空间。重启只把旧 starting/running 投影为 unknown，不接管内部工具位置；是否自动重启由部署者决定，本项目不提供默认 `Restart=always`。

### 演练实际故障处理

先记录 executionId、attemptId 和配置版本，保存受限日志，再独立核对实际容器、宿主入口、工具与远端结果。缺证据保持 unknown，不 retry。全部相关活动停止后，按[取消与恢复](queries.md#取消执行并人工恢复)逐项记录停止确认与外部结果。人工确认不是独立验证。默认执行不限时，运行久、无输出或无心跳不能自动判故障。真实环境演练需要单独授权。

到期清理通过下述 `cleanup` 管理入口执行。普通清理不能按目录年龄、无输出、控制进程退出或取消意图删除活跃/未确认尝试。先核对执行、尝试、停止证据和外部结果，再单独清理已确认结束的设施；保留人工恢复需要的记录、日志和产物。不要使用 `docker container prune`、`docker rm -f` 或批量 `rm` 绕过这一步。DATA 根目录 0700、socket/新建文件 0600；已有文件权限不会自动递归修复，管理员可用 `stat` 核验，并在停止服务且核查执行后按存储策略处理。不要 `chmod -R` 正在运行的 workspace。备份、导出的日志/产物和通知暂存也须限制权限、访问人员及保留期。日志/产物不是秘密过滤器，脱敏后才可分享，发现凭据泄露先撤销凭据再按授权清除敏感副本。

## 到期清理

外部 cron/systemd timer 或管理员脚本调用同一管理入口；控制服务不内置清理定时器，脚本不直接修改 SQLite。

```sh
sandcastle-orchestrator cleanup --socket /srv/orchestrator-data/control.sock
```

socket 请求为 `{"command":"cleanup"}`，返回 `attempts` 中本次处理或已清理的尝试及 `status`，文件失败带 `reason`。只有整个执行已结束满 30 天、全部尝试已结束且无活跃入口、未决、停止未确认或待核对证据才清理。人工 resolve 从核对结束的记录时间起计时；旧记录缺少可信结束时间则保留，不猜测。重试排队或运行时保留该执行全部历史证据。明确启动失败且已结束的 `start_failed` 尝试，事后 cancel 仅保留取消审计，不额外要求停止确认，也不阻挡已结束重试执行的到期清理；真正取消但停止未确认的尝试仍保留。

只 unlink `DATA/attempts/ID/stdout.log`、`stderr.log` 及已登记的单层普通产物文件，同时清理已登记 `toolCalls` 对应的 `tools/CALL_ID/stdout.log`、`stderr.log`、`result.json` 与已登记产物；工具调用活跃、未决、需核查或停止未确认时保留整个执行证据；原 unknown 等事实仅在工具已明确人工确认停止、核对外部结果且 resolve/retry 已保存 reconciliation 后不再阻挡清理，执行核对结束后仍保留满 30 天。另清理 role 的 `context` 校验快照（仅编排器写入、从不挂载或交给 provider）。不删除整个尝试目录，不处理未登记文件、确定性能力可写 workspace、工具自有未登记文件、provider session/worktree、容器或远端对象。可写 workspace 和未登记产物可能包含工具自有资源，归属无法确认时保守保留，管理员核对后另行处理。拒绝符号链接与非普通目标；没有 provider 自动清理承诺。`cleaned` 仅表示上述已确认自有可弃内容已清理，不表示本地空间全部释放。同步本地删除与单写者状态操作串行，清理不停止或强杀执行。

请求、执行、尝试、业务摘要、恢复说明及外部/session 引用保留；attempt 新增 `cleanup.status`（`cleaned`、`failed`、`unknown`）和时间/失败原因。删除前必要保存 unknown，完成后才记 cleaned；崩溃或结束保存失败保持 unknown，文件失败记 failed，重复调用可安全重试。CLI `logs/artifact` 保留原字段并增加 `availability`；已清理、清理失败或未知返回对应状态、空内容，日志 `complete:false`；没有清理记录但文件丢失返回 `unavailable`。产物仍必须已登记。`show/list` 不再将清理过的尝试或工具调用日志标为完整；保留轻量 `toolCalls` 审计与外部引用。`logs/artifact --call CALL_ID`（socket 可选 `call` 字符串）查询该尝试的工具日志/已登记产物，返回同样的可用状态并附 `callId`；不传 `--call` 的旧查询协议不变。旧程序已标记 cleaned 但未清理工具文件的记录可重复 cleanup 补齐。

无需表结构迁移，只增量扩展 JSON facts，旧记录及管理命令继续可用。旧 parent stopConfirmation 不迁移为工具确认；升级后须逐个补录工具停止与外部结果核对，旧 unknown 工具未明确处理前保持保护。旧版本不理解工具 stopConfirmation/reconciliation，降级不得继续恢复、retry 或 cleanup；使用既有停止、完整备份与人工核对回退流程。升级前备份完整 DATA；删除不可通过数据库回退撤销。旧程序不理解 cleanup 状态，降级后不应继续提供证据查询；需要完整恢复时停止服务、核对外部事实并恢复清理前完整备份。

# 安装与包外配置

首版面向 Linux，要求 Node.js 24+。控制服务还需要 util-linux 的 `flock`；执行任务需要 Git、Docker daemon 和管理员预先部署的可信镜像。不会自动安装系统依赖、拉取镜像、加载用户配置或启动服务。macOS/Windows 请使用 Linux 环境或 WSL，本版本不承诺原生执行。

## 安装本地验证产物

目前只验证本地 tgz，尚未发布 npm 或 GitHub Release，也未核实 scope/public 发布权限。不要把下面的本地安装结果当成远端渠道可用。安装生产依赖可能联网，不是离线安装。

维护者在开发仓库中用 pnpm 构建并打包：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm pack --pack-destination /tmp
# /tmp/canxer314-sandcastle-orchestrator-0.1.0.tgz
```

消费者不需要 clone 仓库、pnpm、全局 tsx 或手工编译。以下 prefix 必须独立于配置、运行数据和业务仓库；将 tgz 路径替换为实际产物的绝对路径：

```sh
PREFIX="$HOME/.local/sandcastle-orchestrator"
npm install --global --prefix "$PREFIX" /tmp/canxer314-sandcastle-orchestrator-0.1.0.tgz
export PATH="$PREFIX/bin:$PATH"
sandcastle-orchestrator --version
sandcastle-orchestrator --help
sandcastle-orchestrator serve --help
```

正式命令固定为 `sandcastle-orchestrator`，不会覆盖依赖已有的 `sandcastle` 命令。`--version` 只输出产物版本。无参数、根帮助和子命令帮助不加载配置、不连接 socket，也不创建数据目录。`init` 和 `doctor` 已可使用，见下节；`setup` 可生成真实项目只读问答入口，见 [setup 指南](setup.md)；`demo` 和 `init --reset-demo` 尚不可用。上述命令状态以本地构建产物为准，不表示已经发布。

远端发布需另行授权。完成包名、scope、public 权限及发布后消费核验后，主渠道将是 `npm install --global @canxer314/sandcastle-orchestrator`；固定版本使用 `npm install --global @canxer314/sandcastle-orchestrator@VERSION`，备选是在 Release 下载同一 tgz 后按上面安装。`VERSION` 不是可直接运行的版本号。npm 与 Release 必须使用同一份已验收产物，不重新打包；registry 404 不证明有发布权限。npx 仅用于临时体验，不作为常驻部署方式。

## 初始化演示资源

```sh
sandcastle-orchestrator init
sandcastle-orchestrator doctor
```

init 创建 `~/.sandcastle-orchestrator/` 下独立的 ESM 配置、data/init.json 标记和已提交演示仓库，写入前显示路径并询问。非交互或 JSON 模式使用 `init --yes`；该选项不跳过安全检查。完整资源重复复用，不覆盖已有或不完整目录。doctor 检查依赖、Docker daemon、配置和镜像，缺条件给修复步骤，不自动安装、拉取或执行容器。真实 Docker/模型尚未据本增量验收。

自定义路径、冲突保护、JSON 输出和未初始化诊断详见[演示初始化与环境检查](https://github.com/canxer314/sandcastle-orchestrator/blob/master/docs/onboarding.md)。尚无 `demo` 自动执行入口，不把 doctor 成功当作测试通过。已有高级配置仍可使用下节的显式 serve 流程。

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

## 高级配置的类型与运行时 import

全局 CLI 的依赖不自动成为外部配置的依赖。需要 value import 的配置，请在配置目录建立自己的 ESM 项目，并安装它实际 import 的包；不要设置 NODE_PATH 或导入本仓库的内部源码。

在新的配置目录中准备依赖，tgz 路径替换为实际产物：

```sh
cd "$CONFIG"
# package.json 已包含 "private": true 和 "type": "module"
npm install /tmp/canxer314-sandcastle-orchestrator-0.1.0.tgz zod@4.6.5
npm install --save-dev typescript@5.9.3 @types/node@24
```

公开类型包括 `Configuration`、`ExecutionContext`、`Submission`、`Role` 和 `McpCapability/McpService/McpReference/McpConnection`。运行时导出包括 `configureClaudeMcp`、`createPrAnalysisRole` 和 `createPrSnapshotTool`。以下完整配置只验证加载与定义，不绑定 provider，不调用模型、不读取 snapshot：

```ts
import type { Configuration } from '@canxer314/sandcastle-orchestrator';
import { createPrAnalysisRole, createPrSnapshotTool } from '@canxer314/sandcastle-orchestrator';
import { z } from 'zod';

const scope = { repo: 'owner/example', pullRequests: [31] };
export default {
  version: 'replace-with-deployed-config-commit',
  repos: [{ id: 'example', location: '/absolute/path/to/your/checkout' }],
  environments: [{ id: 'local' }],
  roles: [createPrAnalysisRole(scope)],
  tools: [createPrSnapshotTool({ ...scope, path: '/absolute/path/to/authorized-prs.json' })],
  capabilities: [{
    id: 'accept-only', environment: 'local',
    validate(input: unknown) { z.string().parse(input); },
    run(context) { return { business: context.input }; },
  }],
} satisfies Configuration;
```

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --module NodeNext --target ES2023 config.ts
sandcastle-orchestrator serve --config "$CONFIG/config.ts" --data "$DATA"
```

provider 扩展继续通过 `Configuration.providers` 使用现有 `AgentProvider` 契约；如果配置 import `@ai-hero/sandcastle` 的 provider，需在配置项目显式安装兼容版本 `@ai-hero/sandcastle@0.12.0`。MCP helper 只在对应 harness 支持时使用，不改变 provider 选择或连接。高级 execution、role binding、镜像与授权策略仍由管理员准备；只读问答可由显式 `setup` 生成参考配置，但不会自动执行。

排障时先检查 `node --version`、配置目录的 `package.json`、自身 `node_modules`、文件名和相对 import 路径。`Cannot find package`/TS2307 通常表示配置自己的依赖未装，不能靠全局 CLI 的 node_modules 解决。`service_failure` 故意不输出任意配置异常和堆栈，防止凭据泄漏；先对配置运行上述类型检查，再在受控环境检查可信配置的 import 和定义。不要把环境变量、token 或含凭据的堆栈贴到日志/Issue。`separate` 错误需要调整目录布局，不能删除锁或绕过真实路径检查。

## 资源与开发入口

安装、卸载和换版本只管理程序，不清理配置、data、任务输入、checkout、记录或日志，不迁移数据库，不重启服务。维护和恢复继续按 README 的暂停、停止核对、一致备份及 restore-review 流程执行。格式与管理协议在本次改动中不变，没有删除旧迁移或 rollback 路径。

开发入口仍可用：`pnpm start serve --data /srv/orchestrator-data --config ./examples/config.ts`。开发依赖与消费者运行依赖分开；只有维护者构建和打包时需要 pnpm/TypeScript。

## 本地验收记录

2026-10-16，Linux x86_64、Node.js v24.21.0、npm 12.0.2、pnpm 12.3.4，产物版本 0.1.0。此记录不代表其他 Node 小版本、架构或系统已验收。

可复跑 `pnpm exec vitest run tests/package.test.ts`。测试用 npm pack 构建 tgz，在源码树之外以 npm 的独立 global prefix 安装，从无关 cwd 调用正式命令；另建外部 ESM 项目安装同一 tgz 及类型检查依赖。已验证编译 ESM、声明、bin shebang/权限、版本、根/子帮助、不加载配置、tsx 非类型擦除语法和相对 import、旧 CommonJS 配置兼容、公开类型/value import、真实路径及 symlink 保护，以及现有 socket 的接纳/拒绝/查询。固定 SHA capability 经受控 Docker adapter 到达 completed，并由 CLI 读取日志；这不是实际容器执行或业务脚本验收。

另手动验证 `pnpm pack --pack-destination "$TMP"` 生成同名 tgz，以 npm 的独立 prefix 安装，在无关 cwd 运行版本/serve 帮助，并加载包含 enum 的包外 ESM 配置，经 submit/show 查询到 queued。npm 12 提示阻止 esbuild postinstall，但当前 Linux x86_64 的已安装平台二进制可用；未为此放开安装脚本权限。pnpm 和 npm 打包路径都已实际消费，未证明跨平台行为。

最终 `pnpm run typecheck` 通过；`pnpm test` 共 13 个文件通过，221 项通过、20 项真实环境 opt-in 测试跳过。对应 CLI/socket 回归与 6 项包消费测试均通过。

同日将 `master` 的 `f0684e7` 合入 #75 分支，保留 #74 的 query/management/serve 模块拆分、#75 的帮助/版本免配置入口与 tsx loader，以及 #80 的连接投影校验。typecheck 通过；全套 14 个文件、273 项通过、20 项 opt-in 跳过。定向 CLI/socket、安装消费及连接投影共 5 个文件、122 项通过，其中安装消费 7 项。首次并行运行定向与全套时，定向测试的 serve ready 检查在默认约 1 秒窗口超时；全套通过后，原样串行复跑定向测试全部通过，未放宽断言。合并解决的独立静态审查未发现确定回归。

未运行真实 Docker、模型、私人连接、远端 npm/Release 发布或发布后消费核验。资源保留的完整 install/uninstall/换版本生命周期回归由后续票交付，本票不声称已经完成。

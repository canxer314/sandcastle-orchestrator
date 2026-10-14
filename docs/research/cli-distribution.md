# 正式 CLI 分发与外部 TypeScript 配置

研究日期：2026-10-14。对应 [研究票 #54](https://github.com/canxer314/sandcastle-orchestrator/issues/54) 和 [决策地图 #53](https://github.com/canxer314/sandcastle-orchestrator/issues/53)。源码基线为 `c62a0117fdc504523553b122f4ba1d132b656d87`。本文是研究建议，包名、命令名、渠道和配置兼容策略仍需作出产品决定。

## 建议

先交付普通 npm CLI 包，使用编译后的 ESM JavaScript 和声明文件。建议候选包名 `@canxer314/sandcastle-orchestrator`、命令名 `sandcastle-orchestrator`。同一个 `npm pack` 产物可作为 GitHub release 的安装附件，避免维护第二套安装器。需要 Node.js 24+，用户无需 clone、tsx 命令或 pnpm；Docker、Git、flock 仍是执行环境的独立前置条件。

保留可信 TypeScript 配置及当前 `loadConfiguration` 的绝对 file URL 导入。新演示配置可以使用 Node 原生支持的可擦除类型语法。不要据此宣布任意既有 TS 配置都兼容：从 tsx 切换到原生加载会缩小支持的语法和解析范围，实施前必须确认旧配置契约，必要时把兼容加载器作为 CLI 的运行时依赖，隐藏在 CLI 内部。本文没有验证这种兼容加载器。

## 安装入口有实际重名

只读查询 npm registry 的结果如下。404 只表示本次查询未取得包，不证明该名称可发布、scope 属于维护者，或未来没有占用。

| 查询名 | 当日结果 | 已声明命令 |
| --- | --- | --- |
| `sandcastle` | 200，latest `1.3.3` | `sandcastle` |
| `@ai-hero/sandcastle` | 200，latest `0.12.0` | `sandcastle` |
| `sandcastle-orchestrator` | 404 | 未取得 |
| `@canxer314/sandcastle-orchestrator` | 404 | 未取得 |

证据来自 registry 的 [sandcastle 元数据](https://registry.npmjs.org/sandcastle)、[Sandcastle 0.12.0 元数据](https://registry.npmjs.org/@ai-hero%2Fsandcastle/0.12.0) 和本机已安装的同版本 `package.json`。上游 [package.json](https://github.com/mattpocock/sandcastle/blob/main/package.json) 也声明 `sandcastle`。本项目恰好依赖该包，因此重名不是假设。不要默认提供或强制覆盖 `sandcastle` 别名。scoped 包名也不会给 `bin` 自动加 scope，二者分别命名。[npm scope 文档](https://docs.npmjs.com/cli/v11/using-npm/scope/)、[npm bin 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)。

本轮没有检查 npm 登录账号和 scope 管理权限，没有注册、保留或发布名称。

## npm 包与 release 归档

| 方案 | 用户安装 | 要维护的内容 | 结论 |
| --- | --- | --- | --- |
| npm registry 包 | `npm install -g @canxer314/sandcastle-orchestrator@VERSION` | 编译产物、package 元数据、依赖安装 | 推荐主渠道，版本和升级路径清楚 |
| release 附件为同一个 npm `.tgz` | 下载附件后 `npm install -g ./PACKAGE.tgz` | 相同包，另上传附件与校验和 | 推荐备用渠道；依赖仍可能从 registry 下载 |
| 自包含 Linux `.tar.gz` | 解压版本目录、把入口放入 PATH | JS、生产依赖树、入口脚本、权限、链接、校验和；若无系统 Node 还需运行时 | 可做真正离线分发，但第一版成本更高 |

npm 官方支持按指定版本、文件或 URL 安装 tarball，并通过全局 `bin` 入口调用。[npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)、[npm folders](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)。GitHub release 可附加二进制或其他资产；GitHub 自动提供的源码 zip/tar 不等于可安装 CLI。[GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)。

直接安装源码归档或 Git URL 会把开发工具和构建流程带回用户机器。第一版建议发布已编译 tarball，不使用源码安装作为正常路径。自包含归档还需证明依赖树没有指向开发机 pnpm store 的链接，不能直接把工作区 node_modules 压缩就称作离线包。

## 最小产物契约

当前 [package.json](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/package.json) 是 private、没有 bin/build/files，start 调用 tsx；[tsconfig.json](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/tsconfig.json) 是 noEmit，并包含源码、测试、示例。

实施时建议单独构建配置，设置 `noEmit: false`、`declaration: true`、`rootDir: "src"`、`outDir: "dist"`，只编译 src，继续使用 NodeNext 和 ESM。这样保留现有 `.js` 相对 import 和动态 import。不要为了打包把模块合成一个文件。[TypeScript rootDir](https://www.typescriptlang.org/tsconfig/rootDir.html)。

候选元数据是 `bin: { "sandcastle-orchestrator": "dist/cli.js" }`、`type: "module"`、`engines.node: ">=24"`、`files: ["dist", "templates"]`。仅在存在生成器模板时加入 templates。入口需要 `#!/usr/bin/env node` 和可执行权限。发布前才移除 `private: true` 并确认 scoped public 发布配置；安装 tarball 不要求发布。使用 files 白名单，排除源码、测试、工作目录、配置、凭据、数据及开发依赖。[npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)。

仓库开发仍用 pnpm。发布流程先安装锁定开发依赖、构建、测试再 pack；消费者安装时不构建，也不安装系统依赖。`prepack` 可承接构建，但最终以实际 tgz 内容为准，不能只看工作区 dist 或 dry-run。[npm scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/)、[npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/)。

保留当前四个运行时依赖 `@ai-hero/sandcastle@0.12.0`、`@modelcontextprotocol/server@2.3.1`、`effect@3.20.0`、`zod@4.6.5`。tsx、tsc、vitest 本身不是编译 JS 的必需运行时依赖；如果选兼容 TS 加载器，则 tsx 的依赖分类需要重新确定。记录层使用 Node 自带 `node:sqlite`；本次安装的生产依赖树未发现 `.node` 文件，导入 roles 和 records 成功。这是当前机器、当前依赖树的证据，不是所有 Linux/Node 版本的保证。[records.ts](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/records.ts)、[执行代码](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/execution.ts)、[flock 入口](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/lock.ts)。

## 外部配置需要分别验证运行与类型

[现有 loader](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/config.ts) 使用 `import(pathToFileURL(resolve(path)).href)`。它编译为 JS 后，Node 24.21.0 仍能直接加载位于包外的 config.ts，并执行方法，不需要 tsx。路径经 file URL 处理是正确做法。[Node 24 ESM 文档](https://github.com/nodejs/node/blob/v24.21.0/doc/api/esm.md)。

Node 原生加载不做类型检查、不读取 tsconfig，也不把 `./helper.js` 自动映射到 helper.ts。enum、参数属性、含运行时代码的 namespace 等不属于 strip-only 支持范围；node_modules 里的 TS 也不能靠 stripping 运行。type import 必须明确写 `import type`。生成 config.ts 时应放在明确 `type: module` 的配置目录，或选择 `.mts`；不要依赖启动 CLI 的包决定外部配置的模块制式。Node 24.12 起 stripping 稳定，但当前项目承诺 `>=24`，提高最低版本需要另行确认。[Node TypeScript 文档](https://nodejs.org/docs/latest-v24.x/api/typescript.html)、[TypeScript erasableSyntaxOnly](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)。

已有示例的 `import type { Configuration } from '../src/config.js'` 会完全擦除，因此即使这个路径根本不存在，运行仍能成功。安装产物不含 src，外部示例的这个路径无法作为公开类型 API；必须替换成稳定 package 子入口，例如：

```ts
import type { Configuration } from '@canxer314/sandcastle-orchestrator/config';
```

为该入口导出 `dist/config.d.ts` 并随包交付它引用的声明依赖，types condition 放在运行时 condition 前。是否开放配置辅助函数的运行时入口需另定；不要让类型 API 导入 CLI 顶层代码。[TypeScript 声明发布](https://www.typescriptlang.org/docs/handbook/declaration-files/publishing.html)、[Node exports 条件](https://github.com/nodejs/node/blob/v24.21.0/doc/api/packages.md)。

全局安装 CLI 后，这个 type import 运行成功仍不代表编辑器或 tsc 找得到类型。全局包不是配置目录的普通模块解析路径。本次外部配置 tsc 实测报 TS2307；把同一 tarball 本地安装到配置目录后 tsc 通过。[npm 全局与本地安装](https://docs.npmjs.com/cli/v11/configuring-npm/folders/)。

外部配置的 `import { z } from 'zod'` 同样从配置文件所在目录解析，CLI 的依赖不会自动提供给它。本次无本地依赖时实际报 ERR_MODULE_NOT_FOUND；更改 cwd、依赖全局安装或 NODE_PATH 都不应成为正式 ESM 方案。[Node 24 ESM 解析规则](https://github.com/nodejs/node/blob/v24.21.0/doc/api/esm.md)。

因此初始化流程要选择明确的契约：最小演示配置无第三方 value import，用户无需装配置依赖；需要类型检查或高级配置时，让配置目录成为独立 package，本地安装同版本 CLI 与实际使用的第三方包，并固定版本。若要求演示立即有类型提示，也应在 init 契约中说明配置 package 的依赖准备，不能声称公开 types 已解决全局解析。这个选择留给首次体验决策。

## 打包必须保留目录分离和协议

[paths.ts](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/paths.ts) 把 `resolve(import.meta.dirname, '..')` 当作应用目录。输出为 package/dist/paths.js 时仍指向 package 根；如果默认 rootDir 把源码输出为 package/dist/src/paths.js，它会变成 package/dist，漏掉包根其他内容。因此输出布局不是随意的。

该校验还保护配置文件所在整个目录及其物理路径。`~/.sandcastle/config.ts` 配合 `~/.sandcastle/data` 会被拒绝；`~/.sandcastle/config/config.ts` 与 `~/.sandcastle/data` 才是分离的兄弟目录示意，具体默认路径未决定。本次包级验证确认独立 data 通过、配置目录内 data 和安装目录内 data 都拒绝。相对配置路径继续相对调用者 cwd 解析；应用和模板定位应基于模块位置，不可基于 cwd。

打包改变调用入口，不改变已有命令、JSON stdout/stderr、退出码、Unix socket 消息和持久化格式。新的人类可读帮助或演示输出另立契约，原有脚本仍需通过安装后的入口回归。[现有 CLI](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/cli.ts)、[控制入口](https://github.com/canxer314/sandcastle-orchestrator/blob/c62a0117fdc504523553b122f4ba1d132b656d87/src/control.ts)。

## 版本、升级和可复现验收

安装和升级都给明确的 `@VERSION`，回退同样重新安装旧版本；不让 install 或 update 自动启动长期服务。升级前停止旧控制服务并检查配置 API、数据格式和 socket 兼容性，具体停止流程沿用其已有边界，不把重新安装理解成安全迁移。[npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/)。

直接依赖固定版本不等于固定整个传递依赖树。pnpm-lock.yaml 保证开发构建侧，不是 npm 消费者的安装锁。若要求每次安装使用同一生产依赖树，发布 npm-shrinkwrap.json；npm 官方明确指出它适用于 CLI，并可随包发布。[npm shrinkwrap](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/)。这次探针没有生成 shrinkwrap，因此不证明可复现依赖树。

实际 tarball 的正式验收建议包括：

1. 在 Linux 的干净构建目录安装锁定依赖、编译、pack，检查真实归档白名单、shebang、权限、模板、公开声明和生产依赖。
2. 新建与仓库无关的安装 prefix 和调用目录，移除源码及开发工具可见路径，将 prefix/bin 放入 PATH，安装真实 `.tgz`。验证无参数、help、version，以及已有 CLI/socket 回归；当前源码尚没有这些新帮助命令。
3. 在包外、非 node_modules 的独立配置目录加载可信 config.ts，分别验证运行、公开 types 的 tsc、第三方 value import、相对 TS helper、语法限制和分离路径。不要仅用 import type 的运行结果证明 types 正确。
4. 后续获授权的真实环境执行 demo，经过真实控制服务和 Docker 执行入口，检查固定 SHA 和可读结果；这一步不属于本次包级研究。
5. 要宣称离线安装，预先缓存或随归档提供完整生产依赖，然后断网安装验收。本地 tarball 安装但仍能访问 registry，只证明主包来自本地，不能证明离线。

上述步骤用 [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) 和 [npm install](https://docs.npmjs.com/cli/v11/commands/npm-install/) 即可完成，不需要发布测试包。

## 本次实测范围

使用临时目录 `/tmp/sandcastle-54-probe-bquwzwmt`，Node `24.21.0`、npm `12.0.2`、本机 TypeScript 依赖。只读复制基线 src，用单独构建配置生成真实 ESM 与声明。临时 package 元数据保持 private，加入候选 bin/exports/files，给生成的 cli.js 添加 shebang 和执行权限，再 `npm pack --ignore-scripts`。全局 prefix 和外部配置目录都在这个临时目录中，没有写主工作区或系统全局目录。

| 验证 | 结果 |
| --- | --- |
| 实际 src 编译、npm pack、本地 tgz 安装 | 通过；安装 15 个包，安装时禁用 scripts |
| 不相关 cwd 调用已安装 CLI | 正常输出已有 unknown-command JSON，退出 1 |
| 安装产物加载包外 config.ts | 通过；包括擦除的旧相对 type import 和公开 type import |
| 安装产物导入 roles、records | 通过；不启动任何服务或外部任务 |
| 未安装本地依赖的配置 value import zod | ERR_MODULE_NOT_FOUND |
| 外部 enum 配置 | ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX |
| helper.ts 存在但 import helper.js | ERR_MODULE_NOT_FOUND |
| node_modules 内的 TS 配置 | ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING |
| 全局 CLI 的公开配置类型 tsc | TS2307；配置目录本地安装同一 tgz 后通过 |
| 独立 data / 配置目录内 data / 安装目录内 data | 通过 / 拒绝 / 拒绝 |
| 产物含 src、TypeScript 编译器或 `.node` 插件 | 本次均未发现 |

探针只证明打包布局、原生配置加载和基本安装入口可行。没有启动控制服务，没有运行 Docker、模型、GitHub 写入、真实 demo 或完整 CLI/socket 测试；没有验证 Node 24.0 最低版本、其他 Linux 架构、离线安装、shrinkwrap、正式模板、升级迁移或 npm scope 权限。npm 12 的 pack JSON 输出为按包名索引的对象，本次解析按实际输出处理；正式验收脚本不应假定所有 npm 版本都返回同一种 JSON 外形。

# CLI 首次使用流程原型

对应[首次 init、doctor、demo 如何形成可直接照做的上手流程？](https://github.com/canxer314/sandcastle-orchestrator/issues/55)。这是未确认的体验草案，不能作为已实施功能或真实执行证据。

双击同目录的 `cli-onboarding.prototype.html` 即可运行，不需要依赖或服务器。所有状态都在内存，刷新清空。通过场景标签、逐步引导或自由按钮体验终端反馈。网页是讨论工具，产品仍为 CLI。

## 需要讨论的选择

- `init` 是否默认生成演示，首次写入前展示路径并询问一次，随后不再要求手填 repo、capability 或 SHA？
- 默认路径是否使用 `~/.sandcastle-orchestrator/` 下彼此分离的 config、data、demo-repo？不写当前业务仓库，运行目录保持与配置和 repo 分离。
- 完整演示存在时复用，自定义或不完整文件存在时保留并停止，是否符合预期？
- doctor 只检查并给修复指引，demo 再次预检，所以正常上手为 init、doctor、demo，熟悉后可以 init、demo，是否合适？
- 首次模板是否避免第三方 value import 和类型安装步骤，将公开类型检查、高级配置依赖及 TS 语法兼容留在详细配置帮助中？
- 结果是否分别展示执行结束、测试结果、执行编号及证据位置，并且每一步给下一条命令？

安装入口已在[正式安装入口决策](https://github.com/canxer314/sandcastle-orchestrator/issues/59#issuecomment-6170318669)中确定，本原型沿用它。版本、标识和结果均为模拟示例；完整 help 中的新参数适用范围仍待确认，既有命令与协议不能由本原型改变。

演示服务启动、数据保留、退出、重跑和 Ctrl+C 归属[演示生命周期决策](https://github.com/canxer314/sandcastle-orchestrator/issues/56)。日常提交/查询、可读结果与 JSON 兼容归属[日常命令决策](https://github.com/canxer314/sandcastle-orchestrator/issues/57)。本原型只显示可供讨论的反馈，不能提前关闭这些票。

## 原型限制

没有实际写文件、读取配置、联网安装、运行 Git、启动控制服务、调用 Docker、使用模型或提交真实任务。首次确认与后续演示等待以按钮模拟。镜像沿用现有部署教程示例，不代表发布镜像已验收。doctor 的 Linux/Git/flock/Docker 状态用固定场景表现，未实现发行版检测及真实诊断。原型未处理高级路径覆盖或完整 CLI 解析，也没有变更现有 JSON 输出。

依据为[安装研究](https://github.com/canxer314/sandcastle-orchestrator/blob/40679e912ef874ed1bb3222ed72fd203556bf15a/docs/research/cli-distribution.md)、本仓库 `src/paths.ts` 的目录分离限制、[CLI 设计指南](https://clig.dev/#help)和 [Docker 官方镜像拉取命令](https://docs.docker.com/reference/cli/docker/image/pull/)。

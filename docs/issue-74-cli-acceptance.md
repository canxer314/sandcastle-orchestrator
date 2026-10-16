# Issue #74 CLI 拆分交付记录

## 职责

- `src/cli.ts` 保留原有可执行入口、参数解析、命令及 identifier 校验、直接分派、JSON 输出与错误出口。
- `src/cli/queries.ts` 处理 show、list、logs、artifact、maintenance 的客户端请求。
- `src/cli/management.ts` 处理 submit、cancel、confirm-stop、resolve、retry、cleanup、pause、resume、restore-review 的客户端请求。
- `src/cli/serve.ts` 保留 serve 启动参数与 uncaughtException 处理；服务内部的 ready、信号、配置加载仍由原 `control.serve` 负责。
- `src/cli/arguments.ts` 共享原有必填参数校验，不增加新选项或严格校验。

没有改变管理协议、记录结构、状态机、调度器、迁移或恢复路径，也没有新增公开 CLI library interface。

## 兼容与验收

验收接缝沿用 #74 指定的 CLI 子进程与 Unix socket，不测试内部调用结构。特征测试覆盖必填项与校验顺序、错误 JSON 和退出码、既有参数容忍行为、客户端不加载配置，以及 serve ready JSON、SIGINT 和错误日志。原有回归覆盖异步 submit、accepted:false 退出 0、执行取消及人工核对、日志、产物与清理。

- 实现前 typecheck 与 management、cleanup、maintenance/restore 共 108 项测试通过。
- 拆分后 typecheck 与 management、cleanup、maintenance/restore、execution 共 160 项测试通过，20 项真实环境测试跳过。
- 最终 `pnpm run typecheck` 通过；`pnpm test` 共 12 个测试文件通过，244 项通过、20 项真实环境测试跳过。新增特征测试共 29 项通过。
- Standards 和 Spec 两轴独立审查均无发现。
- 验证环境为 Linux x86_64、Node.js v24.21.0、pnpm 12.3.4。

检查了 README 中的源码入口和管理命令，无公开行为变化，无需修改 README 或新增 changeset。共享工作区已有 README、用户指南与部署指南修改均保留；本票使用独立 worktree。

没有执行真实 Docker、模型调用、远端写入或发布。受控 adapter 的回归不代表真实 provider 验收；服务退出也不代表执行停止。

#75 的打包、help/version 与包外配置不属于本票。共同入口需要在合并前整合并重验两侧行为，本票不要求依赖其未合并分支。

# 隔离任务如何复用前置成果

研究日期：2026-10-17。源码基线：`a8bd3fcae668c47d2388e3aabce94a7207586a09`。关联[成果复用研究](https://github.com/canxer314/sandcastle-orchestrator/issues/114)。这是技术调查和候选建议，未批准任务输入机制或实施规格。

结论：可以实现，也不必先建通用成果传递系统。让 Agent 从已授权的仓库、文档或 issue 读取信息，是可用的低成本方向。但“读到说明”和“工作区包含前置修改”是两件事。成果必须先存在于可访问的位置，代码还必须进入下游任务实际使用的版本。隔离执行本身没有要求 Agent 共用 worktree。

## 本项目已有的基础

- 每次角色执行要求完整 commit SHA，从配置的本地 repo 克隆，再移除 origin；可写实现另建独立 `/implementation` clone。默认源挂载只读，宿主不会直接在 Agent 可写的 Git 目录里做发布操作。限制的是这些共享和信任边界，不是全面禁用 Git。[角色执行](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L30-L36)、[代码准备及挂载](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L73-L125)。
- 当前没有自动拉取前置任务 PR、选择前置成果为基线、合并多个前置分支的路径。已有发布功能把受控测试调用导出的文件重新组成 Git tree/commit，推送专用分支并创建 Draft PR；发布生成的 commit SHA 与 Agent 本地 HEAD 不必相同。应使用发布回执里的 SHA。[发布实现](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/publication.ts#L23-L44)。
- Agent 可调用已配置的只读工具，宿主执行读取并保存观察记录；因此容器不必获得 GitHub 凭据或一般网络访问，就可以通过受限工具读取外部信息。具体 GitHub reader 仍需接入；现有 PR 示例读取的是管理员提供的 JSON，不是实时 GitHub API。[只读工具通道](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/role-tools.ts#L7-L55)、[PR 快照工具](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/pr-analysis.ts#L6-L36)。
- 运行报告和登记的 artifact 已可通过管理查询读取，但这是宿主入口。角色的 `read_tool_file` 只允许当前 attempt 的工具结果，不能直接跨任务读取。若需要前置报告，应增加限定来源 execution/attempt/artifact 的只读适配，不把整个数据目录或管理 socket 暴露给角色。[查询实现](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/record-queries.ts#L116-L171)、[角色读取范围](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/mcp.ts#L71-L90)。
- 当前默认网络为 `none`，环境可配置；不能假设所有容器都有 GitHub 网络、`gh` 或登录态。现有 `completed` 只说明执行生命周期结束，代码中仍可同时记录 `contract:error`，更不证明代码已发布或前置目标达成。publication 也不解释 business.passed，不能把“有测试调用回执”写成“测试通过”。[网络参数](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L97-L110)、[结束与报告校验](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/roles.ts#L182-L203)。

## 候选路线与相对成本

以下成本是依据现有代码差距作出的工程判断，不是工期承诺，也不包含整个工作台和依赖调度的实施。

1. **Agent 读取仓库或 issue 中已有的信息，成本较低。** 任务提供明确的仓库、路径、issue/comment 引用，Agent 用已授权工具自行检索和理解。若相关文档已在当前代码版本里，直接读取即可；实时 issue 读取则补一个受限 reader、鉴权配置、分页和错误处理。无需新成果存储。只有宽泛关键词搜索，容易把旧评论、旧方案当成当前约定；明确引用仍有价值。
2. **用前置代码版本准备下游工作区，成本低到中等。** 用户授权的源已经有代码时，运行前解析分支或 PR 的实际 commit，取回并校验对象，在隔离代码副本中使用该版本。现有固定 SHA 执行可以复用，但当前没有这段来源准备流程。网络、凭据和可克隆的引用由受控准备工具管理，不要求 Agent 操作宿主 worktree。PR 可以尚未合并；读取其中代码不等于授权合并。
3. **让 Agent 读取前置运行的报告，成本低到中等。** 复用已有 artifact 查询和只读工具通道，限定允许读取的前置运行与文件，并保留缺失、清理、截断和版本信息。需要任务到运行的关联及授权检查。当前 read 函数只接收工具 input、配置按角色复用，因此按本次任务的前置集合限制读取，还要补可信执行上下文，不能只把任意 executionId 交给工具就算完成授权。无需把所有报告先复制成另一套“成果包”。
4. **前置修改只留在隔离目录，成本中等，且不能靠检索解决。** 下游看不到未提交文件或未提供给它的本地 commit。可选择让前置任务在原有授权范围内发布到仓库；或者复用 revision 导出，受控地将文件组成可引用的本地 commit，供后续隔离 clone 使用。后者不必推送远端，但目前需要补本地受信任仓库、版本回执、读取范围和保留规则。不能直接共享 Agent 的可写 `.git`。只有执行过捕获 revision 的工具调用，才有对应导出。它遍历普通文件，也可能包含 ignored 和未跟踪文件；采集非原子，测试针对导出后的固定树。当前 exporter 对 symlink、submodule 等有限制，不能声称它已经能传任意项目目录。[导出限制](https://github.com/canxer314/sandcastle-orchestrator/blob/a8bd3fcae668c47d2388e3aabce94a7207586a09/src/revision.ts#L2-L34)。

通用成果平台的成本较高，因为它还要解决格式、存储、访问控制、过期清理、版本选择和恢复。多前置分支的代码合并与冲突处理也不会因“传文件”自动解决。当前需求没有证明必须建设这样的系统。

## 隔离与版本不能省略的边界

Git linked worktree 共享仓库对象和大部分 refs；独立 clone 是另一条可用路径。因此不共享宿主 worktree 与“按指定版本读代码”并不矛盾。[Git worktree](https://git-scm.com/docs/git-worktree)、[Git clone](https://git-scm.com/docs/git-clone)。

- 已合并代码：准备包含该成果的 commit 后再运行；“默认分支最新”在排队期间会变化，应记录实际使用的 SHA。
- 未合并的 PR：可以读指定 PR head 的代码，但应核对所属 repo、ref 和实际 SHA。PR 编号或分支名称不是不可变版本，也不能保证所需 commit 永久可取。[GitHub PR 引用](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/checking-out-pull-requests-locally)、[Git fetch](https://git-scm.com/docs/git-fetch)。
- 只读参考文件：Git 对象已存在时可以用 `git show commit:path` 读取，GitHub Contents API 也支持按 commit ref 取文件，不要求新建或切换 worktree。这只证明可读，不能代替下游实现工作区的代码准备。[Git show](https://git-scm.com/docs/git-show#_examples)、[GitHub Contents API](https://docs.github.com/en/rest/repos/contents#get-repository-content)。
- issue/comment：API 可读取正文和评论，但正文、评论能被修改，评论也能删除。URL、读取时间和摘要只能帮助核对；若要重放当次输入，还须保存实际读取正文，或把约定放进固定 commit 的文档。现有只读工具观察记录可作为复用点。私有资源仍需正确的 API 读取权限；能 clone 仓库不等于能读取私有 issue。[GitHub issue API](https://docs.github.com/en/rest/issues/issues#get-an-issue)、[评论 API](https://docs.github.com/en/rest/issues/comments)。
- 未发布的隔离文件：仓库和 issue 都没有这些内容。必须先发布或受控导出，不能把让 Agent 搜索当作数据已经存在。
- 两个并行前置任务：分别知道它们的 SHA 不等于得到两者的组合代码。需要组合时，由用户安排的任务/角色承担集成、冲突处理和验证，宿主不要机械拼接。具体集成责任仍待产品决策；不在本研究中替另一张地图的[共享分支组决策](https://github.com/canxer314/sandcastle-orchestrator/issues/71)定案。
- 前置重跑：重跑可能产生新 SHA 或新报告。后续运行应记录它实际读取的版本，旧的后续运行不能悄悄改称使用了新成果；何时选择版本及是否重跑属于待定产品规则。

## 本地 Git 探针

使用 Git 2.53.0、临时目录中的合成仓库，无容器、模型、私人凭据或外部远端操作。10 项断言通过，包括独立 clone 看不到未提交修改、远端发布不会自动更新已有源副本、取回正确 commit 后能独立读取成果、tree SHA 不能代替 commit SHA，以及选择一个前置版本不会自动包含另一个前置成果。

第一版探针还暴露了一个容易遗漏的条件：某 commit 对象虽然存在于准备目录，但在移除 origin、失去可供后续 clone 取得的引用后，下一次 clone 未必包含它。增加由受信任准备步骤保留的命名引用后，链式 clone 才取得正确代码。因此“对象存在”“有 SHA”和“下游实际取得该版本”必须分别核对。此结果来自本地 Git 行为，不是 Sandcastle 容器验收。

探针脚本为 [git-probe.py](./git-probe.py)，结果为 [git-probe-results.json](./git-probe-results.json)。运行脚本会在临时目录创建新的合成仓库，并刷新同目录的结果文件。没有运行生产端到端流程；真实容器挂载、GitHub 私有仓库鉴权和异常恢复仍需后续授权的集成验收。

## 建议留给产品决策的最小方向

优先让 Agent 从仓库、文档、issue 和已有报告中读取信息；任务记录可核对的来源。依赖关系表达执行先后，不自动意味着复制全部成果。需要以某份代码继续工作时，运行准备负责取得并固定代码版本；未发布修改需要额外的发布或本地导出步骤。只在具体任务确实需要时选择这条路径。

这保留了 Agent 对内容和业务结论的判断权，也保留隔离、授权与版本核对。研究不把以上建议视为用户已批准方案。

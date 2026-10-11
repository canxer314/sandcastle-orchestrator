---
"sandcastle-orchestrator": minor
---

新增只读外部故障查询示例及服务安全日志，沿用 CLI/socket JSON 与现有状态。启动前后台异常不再伪装排队，标为 start_failed；失败记账失败仍写安全日志。README 说明通知桥接、控制退出与人工接管演练、敏感数据及清理边界，不新增自动处置或执行超时。

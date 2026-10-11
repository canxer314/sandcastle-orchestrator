---
"sandcastle-orchestrator": minor
---

新增 CLI/Unix socket 取消、人工停止确认、结束未决与重试。取消意图先持久化，Docker 仅协作停止并以 inspect 确认停止；重启不接管旧尝试。恢复需记录人工来源、处理、原因及外部结果，重试保留历史并固定旧实际 SHA，使用当前配置。存储增量兼容，回退限制见 README。

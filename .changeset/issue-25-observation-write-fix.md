---
"sandcastle-orchestrator": patch
---

Serialize observation JSONL writes within each role attempt so concurrent large read-only tool results remain complete, independently readable records. Keep tool reads concurrent and deliver each result only after its observation is saved. A failed write does not block later observation saves; the existing sticky evidence error, unresolved attempt state, drain and cleanup protection remain unchanged. No record schema or management protocol changes.

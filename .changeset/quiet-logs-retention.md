---
"sandcastle-orchestrator": patch
---

Add control-service cleanup for orchestrator-owned logs and registered local artifacts after ended, reconciled executions have been retained for thirty days. Preserve lightweight history and provider resources; expose cleaned, unavailable, failed and unknown evidence through CLI/socket queries.

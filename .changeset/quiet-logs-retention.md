---
"sandcastle-orchestrator": patch
---

Add control-service cleanup for orchestrator-owned logs and registered local artifacts after ended, reconciled executions have been retained for thirty days. Preserve lightweight history and provider resources; expose cleaned, unavailable, failed and unknown evidence through CLI/socket queries. Preserve cancellation audit on ended start_failed attempts without requiring an additional stop confirmation for retention cleanup, including history after a completed retry. Active, unresolved and unconfirmed cancelled attempts remain protected.

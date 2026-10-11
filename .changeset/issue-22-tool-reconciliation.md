---
"sandcastle-orchestrator": patch
---

Require explicit per-tool stop and external-result confirmation before resolving or retrying unresolved MCP execution. `confirm-stop --call CALL_ID` optionally selects a historical `--attempt`; the existing parent-only command retains its scope. Preserve unknown tool facts alongside stopConfirmation/reconciliation audit, and allow thirty-day cleanup only after reconciliation. Existing JSON records remain readable without schema migration; old parent confirmations do not imply tool confirmation. Back up full DATA before upgrade; older versions must not manage recovery, retry or cleanup using the new audit semantics.

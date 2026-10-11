---
"sandcastle-orchestrator": minor
---

Add persisted-state primary Agent scheduling with optional global and per-repo limits, default repo serial execution, oldest eligible queue scanning, and restart-safe occupancy until trusted end or manual stop confirmation. Independently submitted deterministic executions bypass primary Agent quotas. Scan executable queued primary Agent requests on control-service startup without restarting unknown attempts. Preserve the existing rule that historical deterministic requests remain queued on restart, even when execution is enabled later.

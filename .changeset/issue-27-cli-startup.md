---
"sandcastle-orchestrator": patch
---

Load execution and provider runtimes only when starting the control service, not for CLI socket requests. Preserve CLI commands, socket protocol and stored records while avoiding repeated server initialization costs for client queries.

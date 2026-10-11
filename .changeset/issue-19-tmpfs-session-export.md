---
"sandcastle-orchestrator": patch
---

Stream role session exports through docker exec cat instead of docker cp so sessions stored in /home/agent tmpfs can be captured. Preserve existing interfaces and records, propagate export and host write failures, and avoid buffering exported files in memory.

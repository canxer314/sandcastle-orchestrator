---
"sandcastle-orchestrator": patch
---

Roll back failed role-tool observation appends to the prior length using the same validated regular-file handle, preserving earlier evidence and independently readable later JSONL records. If rollback fails, reject subsequent observation saves and result delivery for that attempt. Preserve sticky unknown state, report and cleanup protection, concurrent reads, handler drain, record schemas and socket protocol.

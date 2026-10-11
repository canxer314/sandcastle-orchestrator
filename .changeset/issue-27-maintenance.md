---
"sandcastle-orchestrator": minor
---

Add persistent CLI/socket maintenance admission and start pauses, explicit audited resume, paused/restore startup modes and restore side-effect review. Existing records, configuration and management commands remain compatible. Persist explicit deterministic start authorization across maintenance pauses without starting legacy queues. Establish restore gates atomically and invalidate pre-restore start authorization. Document external host backup, restore and upgrade procedures; paused controllers do not stop active harnesses. Verify post-backup local writes against independent host audit before resuming a restored snapshot.

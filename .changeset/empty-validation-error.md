---
"sandcastle-orchestrator": patch
---

Reject submissions when an input validator throws an error with an empty message. Persist the rejection without creating a queued execution, preserving the existing response and record formats.

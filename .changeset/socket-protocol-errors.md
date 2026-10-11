---
"sandcastle-orchestrator": patch
---

Return explicit protocol errors for socket submissions missing input and for unknown management commands. Missing input does not create a request; explicit JSON null continues through capability validation. Existing command responses and persisted record formats are unchanged.

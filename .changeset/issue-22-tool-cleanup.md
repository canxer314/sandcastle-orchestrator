---
"sandcastle-orchestrator": patch
---

Clean expired orchestrator-owned MCP tool logs, result files and registered artifacts while retaining call audit, external references and unresolved evidence. Add optional `--call` / socket `call` selection to logs and artifact queries without changing existing commands; report cleaned tool evidence as incomplete and safely retry older cleanup records.

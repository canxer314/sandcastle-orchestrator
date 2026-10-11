---
"sandcastle-orchestrator": patch
---

Bound role output previews to 65536 UTF-8 bytes without splitting Unicode characters, while retaining the complete report artifact. Cancelled completion omits large business references just as it omits small inline business results; raw reports and source observations remain readable. Existing inline records, SQLite schemas and socket protocol remain compatible.

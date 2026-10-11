---
"sandcastle-orchestrator": minor
---

Add a PR common-problem analysis role with administrator-scoped, read-only snapshot evidence. Roles can call optional deployed `tools[].read` functions through an isolated per-attempt Unix socket; tool observations are saved separately before delivery. The snapshot tool exposes supplied provenance, content digest, PR version/SHA and completeness rather than claiming verified live GitHub facts.

Save role reports as readable artifacts. Outputs and validated business values over 64 KiB use explicit truncation/reference fields instead of unbounded inline records; small and historical inline reports remain unchanged. Add optional artifact byte offsets for complete 1 MiB chunk reads while preserving legacy whole-file responses and their 8 MiB limit. No SQLite schema removals or scheduler business modes.

Controlled public CLI/socket/tool tests pass; real model/container and business-quality acceptance for issue #25 remains pending explicit authorization.

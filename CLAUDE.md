## Development

Use pnpm. Run `pnpm run typecheck` and the relevant CLI/socket tests during implementation, then the full suite before committing.

For issue selection, scope, dependency checks, or status updates, read `docs/agents/issue-tracker.md` first.

Preserve the CLI/socket acceptance seam. Add execution capabilities in independently usable increments; keep business decisions in roles and capabilities rather than the scheduler.

Changes to public behavior need a changeset and a README check. Confirm compatibility before changing persisted records or the management protocol.

跟用户交流默认使用中文。子 Agent 名称使用 `issue-N-` 或 `pr-N-` 前缀。

## Development

Use pnpm. Run `pnpm run typecheck` and the relevant CLI/socket tests during implementation, then the full suite before committing.

For issue selection, scope, dependency checks, or status updates, read `docs/agents/issue-tracker.md` first.

Preserve the CLI/socket acceptance seam. Add execution capabilities in independently usable increments; keep business decisions in roles and capabilities rather than the scheduler.

Changes to public behavior need a changeset and a README check. Confirm compatibility before changing persisted records or the management protocol.

## 语言偏好

跟用户交互时尽可能用中文表述，将中文设为默认交流语言，涉及到专业技术描述可以用英文。

## AI Agent Coding Rules

- Before changing existing interfaces, data structures, or behavior, confirm the compatibility requirements. Remove legacy paths only when it is explicitly confirmed that backward compatibility is not required; do not remove migration or rollback mechanisms on your own initiative.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.

## Rules

子 Agent 名称必须带上所处理的 issue 或 PR 编号前缀，使用 `issue-N-` 或 `pr-N-`，例如 `issue-31-implementation` 或 `pr-31-review`。

## Sub-Agents 选型

关于 `/implement-spec` 中各 agents 使用的 model 以及 effort，严格按照如下配置 kick off。

| 工作 | model / effort |
| --- | --- |
| 日常开发、普通排障 | Sonnet xhigh，必要时 max |
| 多文件功能、复杂重构 | Opus low |
| 反复修不好、需要重新判断根因 | Opus medium |
| 极难问题、关键架构复核 | Opus high |
| 简单文本处理、批量明确任务 | Sonnet medium |

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `canxer314/sandcastle-orchestrator`. Before tracker operations, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging or changing labels, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain concepts or proposing design changes, read `docs/agents/domain.md`.

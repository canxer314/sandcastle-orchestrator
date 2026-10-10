# Issue tracker: GitHub

Issues and specs live in `canxer314/sandcastle-orchestrator`. Use the `gh` CLI for tracker operations.

## Project rules

Read the requested issue and its parent before implementation.

Issue #14 is the first-version specification, not a single executable work item. Select a dependency-ready implementation issue from #15–#29 and keep each increment within its acceptance criteria. Read its `Blocked by` section and check whether each prerequisite is actually implemented before starting downstream work.

Issues #1–#13 preserve closed design decisions. Old `canxer314/sandcastle` links redirect after the transfer. Do not reopen design decisions implicitly.

Before reporting completion, distinguish implemented behavior, controlled-adapter tests, and real-provider acceptance. Record unverified items explicitly. Real model calls, container execution, and external writes require an authorized test environment.

Create, edit, close, or comment on remote issues only when authorized. A local implementation commit does not close an issue or authorize publishing code. Creating labels, assigning issues, and changing dependencies also require authorization.

## Conventions

Run these commands inside this clone. For operations from elsewhere, pass `--repo canxer314/sandcastle-orchestrator`.

- Read an issue: `gh issue view <number> --comments`. Fetch its labels with `gh issue view <number> --json labels`.
- List issues: `gh issue list --state open --json number,title,body,labels,comments`. Apply label or state filters as needed.
- Create an issue: `gh issue create --title "..." --body-file <file>`.
- Comment: `gh issue comment <number> --body-file <file>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

When a skill says "publish to the issue tracker", create a GitHub issue after authorization.
When a skill says "fetch the relevant ticket", read the issue, comments, labels, and parent.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. If a reference is ambiguous, resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Wayfinding operations

For `/wayfinder`, the map is one issue labelled `wayfinder:map`, holding Notes, Decisions-so-far, and Fog.

- Link child tickets as GitHub sub-issues. If unavailable, use a task list in the map and `Part of #<map>` in each child.
- Label children `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- Use native issue dependencies when available. Add blockers with `gh api --method POST repos/canxer314/sandcastle-orchestrator/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the database ID with `gh api repos/canxer314/sandcastle-orchestrator/issues/<blocker> --jq .id`.
- Otherwise, record `Blocked by: #<number>` in the child body.
- Select the first unassigned, open child in map order whose blockers are closed. For implementation work, also verify that the prerequisites are implemented, as required by the project rules.
- After authorization, claim with `gh issue edit <number> --add-assignee @me`.
- To resolve, comment with the result, close the child, and add a summary and link to the map's Decisions-so-far.

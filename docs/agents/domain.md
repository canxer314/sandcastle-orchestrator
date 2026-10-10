# Domain docs

## Layout

This repository uses a single-context layout:

- `GLOSSARY.md` at the repository root defines domain terms.
- `docs/adr/` holds architecture decision records.

## Before exploring

Read `GLOSSARY.md` and ADRs relevant to the area being explored.

If these files or directories do not exist, proceed silently. Do not suggest creating them merely because they are absent. The `/domain-modeling` skill creates them when terms or decisions are resolved.

## Vocabulary

Use glossary terms in issue titles, design proposals, hypotheses, and test names. Respect any synonyms the glossary explicitly excludes.

If a needed concept is missing, reconsider whether it belongs to the project's vocabulary. Note genuine gaps for `/domain-modeling`.

## Decisions

If a proposal contradicts an existing ADR, name the ADR and explain why reopening the decision is warranted. Do not silently override it.

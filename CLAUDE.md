## Parallel agents

Assume another agent is working in this repo right now.

- Give each agent its own worktree and branch. When you spawn a subagent that may edit files, commit, or run git, use worktree isolation.
- Leave the main checkout's branch and working tree as you found them.
- Other agents may be editing shared GitHub issue bodies, such as the wayfinder map. Re-fetch the body right before you edit it and change only your part. Then re-fetch it to confirm everyone's edits survived.

## Merging to main

`main` is protected: every change reaches it through a PR, and PRs merge by squash (`gh pr merge <pr> --squash`). Don't push to `main` directly.

## Wayfinder artifacts

Work on a wayfinder ticket (or on a skill the ticket kicks off) that leaves commits on a branch produces one of two kinds of artifact. Decide which before you open the PR.

### One-off artifacts: keep as a closed PR

Research findings, prototypes and other throwaway work that informed a decision but doesn't belong in the codebase. Keep the branch as a closed PR, which preserves the diff even after the branch is deleted:

1. Push the branch.
2. `gh pr create --base main --head <branch> --label wayfinder:artifact --title "<ticket title>" --body "Artifact for <ticket title>. Refs #<ticket>"`, then `gh pr close <pr>` straight away, without merging.
3. Link the PR from the ticket's resolution comment.

### Permanent artifacts: merge to main

ADRs, `CONTEXT.md` changes, agent docs and anything else later work reads from `main`. Open a normal PR to `main` (no `wayfinder:artifact` label) and leave it open. Don't merge it yourself: the human merges.

1. Push the branch and open the PR, with `Refs #<ticket>` in the body.
2. Link the PR from the ticket's resolution comment and the map entry.
3. **Tell the human, clearly and separately from the rest of your report, that the PR needs merging to `main`**, and what depends on it (for example, tickets that build on the ADRs).

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on TaylorZowtuk/recipes, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

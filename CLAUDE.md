## Parallel agents

Assume another agent is working in this repo right now.

- Give each agent its own worktree and branch. When you spawn a subagent that may edit files, commit, or run git, use worktree isolation.
- Leave the main checkout's branch and working tree as you found them.
- Other agents may be editing shared GitHub issue bodies, such as the wayfinder map. Re-fetch the body right before you edit it and change only your part. Then re-fetch it to confirm everyone's edits survived.

## Wayfinder artifacts

When work on a wayfinder ticket (or on a skill the ticket kicks off) leaves commits on a branch, keep that branch as a closed PR. The PR preserves the diff even after the branch is deleted:

1. Push the branch.
2. `gh pr create --base main --head <branch> --label wayfinder:artifact --title "<ticket title>" --body "Artifact for <ticket title>. Refs #<ticket>"`, then `gh pr close <pr>` straight away, without merging.
3. Link the PR from the ticket's resolution comment.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on TaylorZowtuk/recipes, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

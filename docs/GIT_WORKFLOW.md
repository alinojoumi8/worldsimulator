# Git and GitHub release workflow

This document is the repository contract for moving a completed feature into
`main`. It is intentionally conservative: every change must be attributable to
one feature, validated with recorded evidence, reviewed in a pull request, and
merged only after an explicit approval.

## Branch and worktree policy

- Keep `main` releasable and protected. Do not develop directly on it, force-push
  it, or merge locally to bypass the pull request.
- Use one focused branch per feature or fix. Prefer an isolated worktree when
  another worktree already contains user changes.
- Before any mutation, record `git status --short --branch`,
  `git worktree list`, `git branch --show-current`, and `git remote -v`.
- Treat every pre-existing change as user-owned. Do not reset, clean, overwrite,
  or stage it unless the user explicitly includes it in the feature.
- Keep normal commits focused and meaningful. The pull request is squash-merged
  after review; do not rewrite history merely to make the branch look tidy.

## Definition of feature complete

A feature is ready for publication only when all of the following are true:

- The implementation, tests, documentation, and setup or migration notes are
  complete for the requested scope.
- The branch contains no unrelated files or accidental generated artifacts.
- The feature branch has been rebased on the current `origin/main`, or the
  repository owner has documented why that is not appropriate.
- Required local gates have run successfully, and any skipped or manual gate is
  recorded with its reason.
- The staged patch has been reviewed and passes `git diff --cached --check`.
- No credentials, tokens, private data, hidden model reasoning, or local-only
  state are present in the commit.

## Validation gates

Run these commands from the repository root unless a narrower, documented gate
is appropriate:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

The Agent Laboratory gate is required when its script is present:

```text
pnpm gate:agent-lab
```

Focused tests are useful for iteration, but they do not replace the required
release gates. Real-provider, real-Hermes, or other network-dependent pilots are
manual release evidence, not ordinary deterministic CI. Never describe an
unrun gate as passing.

## Commit and push

1. Inspect unstaged and staged changes, then stage only the intended paths:

   ```text
   git add -- <path>...
   git diff --cached --check
   git diff --cached --stat
   ```

2. Use a short imperative subject under 72 characters, following the repository
   convention (`feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, or
   another appropriate allowed type).
3. Push the focused branch with tracking:

   ```text
   git push -u origin <feature-branch>
   ```

4. Verify the remote branch points at the commit that was reviewed. Do not push
   a mixed-scope worktree or force-push a shared branch.

## Pull request

Open a draft PR first, using `.github/PULL_REQUEST_TEMPLATE.md`. The PR must
state the outcome, important changes, exact commands and results, screenshots or
“Not applicable,” setup or migration steps, risks and limitations, and
documentation status. Keep it draft while implementation, testing,
documentation, or review is incomplete.

Review the final changed-file list, patch, CI checks, approvals, conversations,
mergeability, and head SHA. Address review feedback in new focused commits and
rerun the affected gates. Required CI checks must match the actual workflow job
names; update branch protection whenever those names change.

## Merge and cleanup

Merging requires an explicit approval in the current conversation. Before
merging, verify that:

- the PR head SHA is the reviewed commit;
- required checks are green;
- required approvals exist and conversations are resolved; and
- the branch is current with `main`.

Use GitHub's squash merge with the expected head SHA. Do not simulate completion
with a local merge. After a successful merge, delete the remote feature branch
when repository policy permits, fetch/prune, fast-forward local `main`, and
verify the resulting commit and worktree state. If unrelated dirty changes were
preserved, report them instead of claiming the tree is clean.

## GitHub permissions and fallback

Use the GitHub connector for PR, review, check, and merge metadata when it has
write access. Use local `git` for branch, stage, commit, fetch, and push
operations. If the connector is read-only, verify `gh auth status` and use an
authenticated local `gh` command only as the explicit fallback; report that
fallback in the handoff. Never print tokens or credentials.

## Branch protection recommendation

Protect `main` with pull requests, required CI checks, at least one approval,
resolved conversations, no direct or force pushes, and squash-only merging.
Consider a merge queue after the required checks are stable. Keep the real
Hermes pilot outside ordinary network-dependent CI and make it a separately
recorded release gate.

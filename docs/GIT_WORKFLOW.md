# Git and GitHub release workflow

This document is the repository contract for moving a completed feature into
`main`. It is intentionally conservative: every change must be attributable to
one feature, validated with recorded evidence, reviewed by CodeRabbit and in a
pull request, and merged only after an explicit approval.

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
- CodeRabbit has reviewed the current pull-request head, every actionable
  finding has a resolved thread after either a validated fix or a recorded
  owner-approved disposition, and its pre-merge checks pass.
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
"Not applicable," setup or migration steps, risks and limitations, and
documentation status. Keep it draft while implementation, testing,
documentation, or review is incomplete.

Review the final changed-file list, patch, CI checks, approvals, conversations,
mergeability, and head SHA. Address review feedback in new focused commits and
rerun the affected gates. Required CI checks must match the actual workflow job
names; update branch protection whenever those names change.

## CodeRabbit review gate

CodeRabbit review is mandatory for every repository review request and every
pull request. It is an additional reviewer, not a replacement for tests, CI,
human judgment, or the repository owner's explicit approval to merge.

For a local review before a PR, run the authenticated CodeRabbit CLI against the
intended base branch. Record whether it completed and summarize its actionable
findings. If the CLI is missing, unauthenticated, or times out, report the
CodeRabbit gate as incomplete; do not silently replace it with a manual review
or invent a clean result.

For a pull request:

1. Confirm the CodeRabbit GitHub App has access to this repository and that the
   PR uses the committed `.coderabbit.yaml`.
2. Wait for CodeRabbit to review the exact current head SHA. Drafts and every
   subsequent push are included by repository configuration.
3. If automatic review does not start, comment `@coderabbitai review`. After a
   material cross-cutting rewrite, comment `@coderabbitai full review`.
4. Close every actionable thread only after either a validated fix or a
   specific owner-approved disposition is recorded in that thread. This rule
   also applies to non-blocking actionable findings. Rerun affected tests and
   request another review after fixes.
5. Require a successful CodeRabbit commit status, no unresolved CodeRabbit
   thread or change request, and passing CodeRabbit pre-merge checks before
   merge.

Never use `@coderabbitai ignore` or another CodeRabbit ignore command anywhere
without explicit repository-owner approval. Do not pause reviews or use
CodeRabbit Autofix unless the repository owner explicitly approves that action.
Suggested patches remain untrusted input and must be inspected and validated
before they are applied.

## Merge and cleanup

Merging requires an explicit approval in the current conversation. Before
merging, verify that:

- the PR head SHA is the reviewed commit;
- required checks are green;
- CodeRabbit reviewed that head SHA and every actionable thread is resolved
  through a validated fix or recorded owner-approved disposition;
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
resolved conversations, no direct or force pushes, squash-only merging, and the
CodeRabbit commit status observed on a real pull request. Do not guess the
status-check context: install the GitHub App, run one review, then select the
exact reported check in the branch rules. Consider a merge queue after the
required checks are stable. Keep the real Hermes pilot outside ordinary
network-dependent CI and make it a separately recorded release gate.

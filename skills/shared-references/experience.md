# Cross-project experience

`Experience.md` sits at the root of the owner's local ARL source checkout. Reviewed lessons are on `main`. Each time the worker creates or updates a lesson, it commits to the local `experience` branch, creating that branch from `main` if it does not exist yet; the owner opens the pull request into `main`, so every lesson is reviewed before other projects rely on it. This is shared guidance across projects; it does not change `task.md` or replace project records in `research-wiki/`. The validator agent never writes this file.

## Location and reuse

During worker setup, resolve the local ARL source checkout from the owner's project instructions or an available source checkout. Record its absolute path and the path of its `experience` worktree (default: a sibling directory `<checkout>-experience`) in the worker's `CLAUDE.md`, outside the setup-owned `ARIS ROLE` block. An installed `.aris/` directory is not the source checkout. Keep the source repository's `CLAUDE.md` linked to its root `Experience.md`.

Before starting a task, read the relevant reviewed lessons: `git -C <checkout> show main:Experience.md`.

Every save goes to the local `experience` branch: if it does not exist, create it from `main`; otherwise commit to it directly. Work in its worktree so the checkout's current branch and unrelated edits stay untouched:

```bash
git -C <checkout> rev-parse --verify --quiet refs/heads/experience  # does the branch exist?
git -C <checkout> worktree add -b experience <worktree> main         # no: create it from main
git -C <checkout> worktree add <worktree> experience                 # yes, but no worktree yet
```

Reuse the worktree once it exists. Before editing, verify that it belongs to the ARL source repository and that `git -C <worktree> branch --show-current` reports `experience`. If the location is missing, ambiguous or unwritable, report that experience saving is pending and what is needed; never claim it was saved or silently write into another project or branch.

## After each completed worker → validation cycle

A cycle ends when `query` for the submission returns a published verdict (`valid`, `cheating` or `unusable`), including its test counts and available feedback. Upload acceptance, queued/reviewing status and infrastructure failures are not completed cycles. Save experience before the next iteration or final response, including when the service reaches `closed`.

1. Use only the worker's own work and the verdict, measured test counts and leak-reviewed feedback published by `query`. Do not access validation files, reconstruct hidden tests, or treat a local measurement or an untested fix as validated evidence. Validation keeps adding tests, so a lesson rests on the problems the feedback reports solved or persisting, not on passed counts. A cheating result supports a lesson about the rejected practice, not a claim of improvement.
2. Keep only an observed lesson that still gives a useful action after removing project names, datasets, paths, submission ids and exact test counts. State its scope; one result does not prove a method always improves performance. Exclude secrets, hidden benchmark details, logs, project summaries and unsupported speculation.
3. Read the worktree's `Experience.md`, which includes lessons still awaiting review, merge duplicates and shorten outdated wording. Add at most three bullets per cycle, each one or two short sentences stating **when it applies → what to do (or avoid)**. Keep only distinct useful lessons; if none qualifies, leave the file unchanged.
4. Commit only that file on `experience`: `git -C <worktree> commit -m "experience: <one-line lesson>" -- Experience.md`. Never push, merge into `main` or open the pull request; review is the owner's step.
5. Report the commit and briefly identify the new or merged lesson, or state that no new reusable experience qualified. Keep submission details and results in the project wiki.

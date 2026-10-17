## ARIS role: worker

You are the worker. `task.md` is the whole task. Deliver through the `aris-validation` MCP server; its `query` verdict, test counts and feedback are the only measure of progress. Validation is adversarial: it keeps adding hidden tests derived from the problems it finds, so the number of tests grows and a passed count is not a score to chase. Progress means fewer real problems.

### Memory

- **Long-term memory is mandatory.** Everything that must outlive this session goes into [research-wiki](.claude/skills/research-wiki/SKILL.md): the problems, what existing work did about them (surveys), each idea tried, each experiment and tested submission, and which were effective or ineffective, linked by evidence edges. Read `research-wiki/query_pack.md` at the start of every iteration and record each result as soon as you have it; a result that exists only in the conversation is lost.
- **Short-term tasks go in the todo list** (TodoWrite): every step of the current iteration and every issue from feedback. Mark an item done only when it is finished.
- Cross-project lessons: read the reviewed ones from `main:Experience.md` in the ARL source checkout and commit new or updated ones to its local `experience` branch, creating it from `main` if missing (paths recorded in this file); follow [the experience contract](.claude/skills/shared-references/experience.md).
- Environment facts and repeated procedures go into the [environment skill](.claude/skills/{{PROJECT_SLUG}}-environment/SKILL.md), never into the wiki.

### Iteration (follow every step, in order)

1. **Read** the query pack, the relevant wiki pages, the latest feedback and the applicable lessons in `Experience.md`.
2. **Choose** one or more open problems (a `[regressed]` one first) and an idea that is not a repeat of an ineffective one. When the wiki does not cover the problem, survey existing work with WebSearch/WebFetch (or a literature skill, if installed) and record each work with `ingest_survey --arxiv-id` or `--url`. Record the idea against its problems before working on it.
3. **Plan** the iteration in the todo list.
4. **Run** experiments through the environment skill's scripts. Several may run at once, each under its own name. Record each experiment that informs the decision, labelling local measurements as local.
5. **Commit** the code and files that produce the deliverable (run `git init` first if needed) and note the hash; each submission maps to exactly one commit. Keep `.git/` out of the zip.
6. **Submit** with the commit hash as `note`: `submit` returns a one-time upload URL; upload with `curl.exe --fail-with-body -T deliverable.zip "<upload_url>"` (plain `curl` outside Windows), then poll `query` until the submission's status is final. `tested`, `rejected_cheating` and `unusable` carry a verdict. `invalid`, `expired` and `failed` do not count: read `reason`, fix it and submit again.
7. **Record** the verdict as an experiment with the test counts copied from `query` and the commit hash, mark the idea effective or ineffective, and link which problems it solved or left in place. File every issue from the feedback as a problem and add it to the todo list.
8. **Save experience**: commit new or updated lessons to `Experience.md` on the local `experience` branch, creating it from `main` if missing, per the contract (the owner reviews them by pull request), or state that no new lesson qualified.
9. **Continue** with step 1 until `query` reports `closed` (no submissions left); passing every current test does not end the task. While reviews are still running with no submissions remaining, keep polling.

### Rules

- A deliverable is one zip whose root, or single top-level folder, holds `USAGE.md`: what it is, how to install it and how to call it on one input. Validation writes its own adapter from that document and runs its own hidden, growing benchmark; it never runs your evaluation code.
- Submissions are limited. A malformed zip or a missing `USAGE.md` is rejected and not counted. A cheating verdict voids every test result: reading the benchmark's data, hard-coding answers, special-casing the problems named in feedback instead of fixing them, or behaving differently under evaluation.
- Feedback describes the real problems: what goes wrong, which requirement it breaks, how often and how badly. It never contains the tests; do not try to recover them. Fix each problem in general, because new tests around it will follow.
- Test counts come from `query`, never from your own measurements.
- Read a skill before using its tools: [browser-act](.claude/skills/browser-act/SKILL.md) for rendered pages, [aris-setup](.claude/skills/aris-setup/SKILL.md) step 5 for extending the environment skill. After skills change, tell the owner to run `reload-skills`.

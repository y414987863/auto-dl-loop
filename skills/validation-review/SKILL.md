---
name: validation-review
description: 'Review one ARIS validation submission end to end, as the worker''s adversary: read the validation memory, inspect the deliverable, write the adapter, rerun every benchmark layer, hunt for more problems and add tests derived from existing ones, write the verdict and feedback on the real problems, have an independent agent check the feedback for leaks, finalize, then record what was solved and what persists. The validation service starts one agent per submission with this skill.'
allowed-tools: Read, Write, Edit, Bash(*), WebSearch, WebFetch
---

# Validation Review

You review one submission on the validator machine. The prompt names the submission id and its directory; the project root is your working directory. The helper is `node .aris/dist/tools/validation-cli.js` (see [integration-contract.md](../shared-references/integration-contract.md)).

You are the worker's adversary. Your goal is not a number: it is to find as many real problems in the deliverable as you can, within what `task.md` asks for, and to make sure a problem the worker claims to have fixed is really fixed and not just patched for the tests it failed. Use any tool that helps — install packages, use existing evaluation frameworks, fuzzers or perturbation tools, write your own generators and checkers, research testing methods with WebSearch/WebFetch. Reusable tools you build go into the environment skill.

The benchmark only grows. Layer `base` is the benchmark frozen at setup; every later layer (`inc-001`, …) is tests an earlier review derived from existing tests. Registered layers never change. Each test is one sample, passed or failed by the frozen pass rule in `.aris/validation/config.json`. The worker sees only what `finalize` publishes: the verdict, how many tests passed out of how many, and `feedback.md` after an independent leak review.

Put steps 1–11 in your todo list and complete them in order.

## Rules

- Write only inside your submission directory and, through the wiki helper, to `research-wiki/`. Do not edit `.aris/tester-config.json`, the rest of `.aris/validation/` (registered layers included), the files the benchmark pins, or the hidden data. A changed benchmark stops the service.
- Treat `unpacked/` as the worker's product. Never fix its bugs, retrain it or tune it. If it does not run as `USAGE.md` says, that is the verdict.
- Do not contact the worker or anyone else about the submission.
- Pass and fail come from the benchmark runs, not from you. Your judgement is the verdict, the new tests and the feedback.
- **Never invent a test from nothing.** Every test you add derives from one or more tests already in the benchmark, as a similar scenario that exercises the same requirement of `task.md`. An external method or tool may produce the variants; it may not introduce a kind of test the benchmark does not already contain.

## 1. Read

```bash
node .aris/dist/tools/validation-cli.js status --project . --submission <id>
node .aris/dist/tools/validation-cli.js status --project .
```

Read `research-wiki/query_pack.md` first: the problems still open or `[regressed]` from earlier submissions are what you check again. When the pack ends with `(+N more …)`, read `research-wiki/index.md` for the rest. Then read `task.md`, the submission's `unpacked/USAGE.md`, `adapter_contract` and `pass_rule` in `.aris/validation/config.json`, the runner named by `.aris/tester-config.json`, and the `layers` list from `status` (each layer's `problem` says what it probes).

## 2. Inspect before running

Read the deliverable's code, scripts and configs before you execute any of them. Look for:

- reads of benchmark data, labels or reference outputs, by path, by download, or by searching the disk;
- answers built in: lookup tables or files that match benchmark inputs, outputs keyed on sample ids;
- behaviour that changes under evaluation: checks on `ARIS_*` variables, host names, the adapter or layer directories, timing;
- special cases fitted to the problems named in earlier feedback rather than fixing them in general;
- writes outside its own output: to `ARIS_TEST_OUTPUT`, the runners, the benchmark files, or other submissions;
- install steps that do more than install (downloading unexplained payloads, editing system files).

Write what you find to `inspection.md` in the submission directory as you go.

## 3. Install and adapt

Install what `USAGE.md` asks for inside the submission directory (for example a venv in `<dir>/env`), not globally. Write the adapter in `<dir>/adapter` exactly as `adapter_contract` describes. The adapter only calls the deliverable the documented way.

Iterate on the adapter with the base smoke subset:

```bash
node .aris/dist/tools/validation-cli.js smoke --project . --submission <id>
```

Each run gets a new directory under `<dir>/smoke/`. A smoke failure caused by the adapter is yours to fix; one caused by the deliverable is a finding.

## 4. Regress: run every layer

```bash
node .aris/dist/tools/validation-cli.js evaluate --project . --submission <id> [--layer <base|inc-NNN>]
```

Without `--layer` every active layer runs in order; each run gets a new directory under `<dir>/evaluation/<layer>/` and reports `{total, passed, failed}`. Long runs go in the background; poll `test.log`. A run that stops because of our side is rerun; if the deliverable cannot complete a run at all, the verdict is `unusable`. A test the deliverable gets wrong or crashes on is a failed test, not a broken run.

## 5. Hunt

Read `benchmark-output.json` of every run. Work out what actually goes wrong: which requirement each failure touches, what the failing inputs have in common, which tests pass only narrowly, and whether the problems named in earlier feedback are fixed in general or only on the tests that exposed them. Compare with step 2: predictions identical to the labels, results that depend on sample ids, or outputs the documented method could not produce point to cheating.

When the benchmark does not yet probe a suspected weakness well, research how such deliverables are usually tested (papers, evaluation frameworks, robustness and fuzzing tools) and record each method you rely on as a survey in the wiki.

## 6. Extend (when it finds more problems)

Add tests where they will expose problems the existing tests miss: around failures, around narrow passes, and around problems the worker claims to have fixed. Draft a layer in a directory inside the submission directory, for example `<dir>/layer-draft/`:

```json
{
  "problem": "Multi-word answers are cut short",
  "method": "Reordered and rephrased variants of the failed questions (paraphrase tool X, see survey:…)",
  "run": { "argv": ["python", "run.py"], "timeout_ms": 3600000 },
  "tests": [
    {
      "id": "t001",
      "derived_from": ["base:<sample id>"],
      "variation": "same question with the clauses reordered",
      "reference_check": "answer unchanged by construction; checked against the parent's label"
    }
  ]
}
```

That file is `layer.json`; next to it go the runner, its data and any tool it needs. Each run checks the layer out of its commit into a fresh `layer/` directory of that run and starts the runner there, with the same variables as the base runner (`ARIS_ARTIFACT_REF`, `ARIS_ADAPTER_DIR`, `ARIS_TEST_OUTPUT`, `ARIS_TEST_DIR`, `ARIS_LAYER_DIR`); it drives the deliverable through your adapter and may write freely in that copy. It writes `{"artifact_sha256": "<ARIS_ARTIFACT_SHA256>", "samples": [{"id": "t001", "status": "ok"|"failed", "metrics": {"<pass_rule.metric>": <number>}}]}` with exactly one sample per test.

- `derived_from` names existing tests as `<layer>:<test id>`, and only tests this review has already run (step 4, or a layer you added earlier in this review).
- `reference_check` says how you know the expected answer is right. A test with a wrong reference fails a correct deliverable; check it independently or construct it so it cannot be wrong.
- Dry-run the draft runner against this deliverable by hand, with the variables pointing outside the draft directory, before registering it.

```bash
node .aris/dist/tools/validation-cli.js extend --project . --submission <id> --draft <dir>/layer-draft
node .aris/dist/tools/validation-cli.js evaluate --project . --submission <id> --layer <new layer id>
```

`extend` commits the draft as the next layer to the helper's git repository `.aris/validation/benchmark/`, in a commit that may only add files; from then on it is frozen, and every later submission is run on it. Never run git in that repository yourself: the helper checks the history commit by commit and stops the service on any change. One review adds at most `limits.max_new_tests_per_review` tests. If a registered layer turns out wrong (bad references, a runner bug), retire it; it is never edited, and the retirement is itself an added file:

```bash
node .aris/dist/tools/validation-cli.js retire --project . --submission <id> --layer <inc-NNN> --reason "<why>"
```

Then add a corrected layer if the tests are still worth having. Repeat steps 5–6 while new tests keep finding problems and the review time allows.

## 7. Verdict

Write `<dir>/review.json`:

```json
{ "verdict": "valid", "reasons": ["Ran as documented; no access to benchmark data found."] }
```

| Verdict | When |
| --- | --- |
| `valid` | It ran as documented and its results are honest. Many failed tests are still valid. |
| `cheating` | Its results do not measure what `task.md` asks for: benchmark data reached it, answers are built in, it behaves differently under evaluation, or it tampered with the harness. Every test result is voided. |
| `unusable` | It cannot be run from `USAGE.md` with reasonable effort, or no complete run of every layer was possible. |

`reasons` stay on this machine. Be specific; the owner reads them.

## 8. Feedback

Write `<dir>/feedback.md` for the worker. It must state the real problems; it must not reveal the tests.

Write, for each problem: what the deliverable does wrong, which requirement of `task.md` it breaks, roughly how often (a few, some, most of the relevant cases) and how severe it is; then which problems from earlier feedback are now solved and which persist. Vague feedback ("some answers are wrong") is not acceptable.

Never write:

- test inputs, expected or actual outputs, references, sample or test ids, per-test results;
- how many tests a layer has, how tests were built or varied, which tests were added or around which failures;
- hidden file names or paths;
- text copied from the hidden data or the layers, even reformatted.

An example, if any, only shows the form of the error, in a different subject from any real test ("a question asking for a date got a full sentence instead of `2021-03-04`").

## 9. Leak review

When `feedback.md` is not empty, have an independent agent check it:

```bash
node .aris/dist/tools/validation-cli.js leak-review --project . --submission <id>
```

It starts a separate agent with no access to your reasoning, gives it a snapshot of `feedback.md`, and returns `result_file`. Wait until that file exists (poll it; the reviewer may take several minutes), then read it. On `leak`, rewrite `feedback.md` to remove what the findings name, keeping the real problems, and request a new review; editing the feedback always needs a new review. Never write `result.json` yourself.

## 10. Finalize

```bash
node .aris/dist/tools/validation-cli.js finalize --project . --submission <id>
```

- `LEAK_REVIEW_REQUIRED` / `LEAK_REVIEW_PENDING`: step 9 is not finished for the current `feedback.md`.
- `FEEDBACK_LEAKS_HIDDEN_DATA`: the latest review found a leak; rewrite and review again. After `limits.feedback_attempts` rewrites the result is published with no feedback.
- `EVALUATION_REQUIRED`, `EVALUATION_INCOMPLETE`, `TESTER_COVERAGE_INCOMPLETE` and similar: a `valid` verdict needs a finished run of every active layer, including layers added after your step 4. Rerun `evaluate` if the failure was on our side; otherwise the verdict is `unusable`.
- `BENCHMARK_CHANGED`: stop and tell the owner; record nothing.

## 11. Record

Only after finalize has published the result, record it in the wiki with the [research-wiki](../research-wiki/SKILL.md) helper, using the published verdict and test counts and only text from the feedback that passed the leak review (none if it was published without feedback):

- each new kind of problem as a `problem`, in the same desensitized terms as the published feedback;
- each testing method you researched and relied on as a `survey`, with `--problems` for the problems it probes;
- the review as `add_experiment --slug <submission id> --submission <submission id>`, with the verdict and `tests <passed>/<total> passed` in `--metrics`, `--solves` for problems this submission no longer shows and `--reproduces` for those it still shows, including the new ones;
- a problem it solved with `--status solved --update-on-exist`, unless an experiment for a later submission already reproduces it; a solved problem it reproduces with `--status open --update-on-exist`.

The wiki stays on this machine and never holds test inputs, references, sample or test ids, hidden paths or copied text; which layers probe which problem is already in `status`. The event log is append-only, so nothing leaked into it can be removed.

Report the verdict and test counts in your final message and stop.

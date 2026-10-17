## ARIS role: validator

This project tests deliverables for the task in `task.md`, as the worker's adversary. The `aris-validation` service script (see `paseo.json`) receives submissions and starts one validator agent per submission (Codex at `max`) with the `validation-review` skill. Its goal is to find as many real problems in each deliverable as it can within `task.md`, not to produce a score.

- **Long-term memory is mandatory.** `research-wiki/` on this machine records the problems found across submissions, which ones each submission solved and which persist, and the testing methods researched. Every review reads `research-wiki/query_pack.md` first and records the published result after finalizing, using only text that passed the leak review. It never holds test inputs, references, ids or anything copied from the tests.
- **Short-term tasks go in the todo list**: the review steps of the current submission.
- **Follow the `validation-review` steps in order**; none may be skipped. An agent started by `leak-review` is not a validator agent: it follows only `.agents/skills/validation-review/leak-review.md` and writes only its `result.json`.
- The benchmark only grows. The base layer in `.aris/tester-config.json`, the pass rule in `.aris/validation/config.json` and every layer registered in the git repository `.aris/validation/benchmark/` are frozen. New tests are added only through `extend`, each derived from tests already in the benchmark as a similar scenario; never invent a test from nothing, and never edit a registered layer, the files it pins, or the hidden data.
- Any tool may be used or built to find problems: existing evaluation frameworks, fuzzers and perturbation tools, methods found by researching the web, or your own generators and checkers.
- Feedback states the real problems and never the tests. It is published only after an independent leak reviewer, started with `leak-review`, passes it.
- A validator agent runs from the project root; it writes only inside its submission directory and, through the wiki helper, to `research-wiki/`. It never sends anything to the worker; the service publishes the verdict, the test counts and the feedback that passed the leak review.
- Machine facts, repeated procedures and reusable testing tools live in the [environment skill](.agents/skills/{{PROJECT_SLUG}}-environment/SKILL.md).
- Status for the owner: `node .aris/dist/tools/validation-cli.js status --project .`

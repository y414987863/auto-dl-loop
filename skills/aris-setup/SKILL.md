---
name: aris-setup
description: 'Configure the installed ARL worker or validator role and write the project environment skill. Use for "/aris-setup", aris setup or 配置项目.'
allowed-tools: Read, Write, Edit, Bash(*), AskUserQuestion
---

# ARIS Setup

ARIS runs one task on two machines. The **worker** builds a deliverable; the **validator** owns an append-only benchmark and tests each submission as the worker's adversary, adding tests derived from the problems it finds. The task ends when the counted submissions run out. The two talk only through the validation service's MCP tools. Each machine runs official Paseo, so the owner sees both sides' agents.

The role is chosen at installation from the owner's prepared local Git checkout (`bash distribution/install-aris.sh --role worker|validator --project PATH`) and fixes the agent:

| Role       | Agent       | Paseo thinking | Instructions |
| ---------- | ----------- | -------------- | ------------ |
| worker     | Claude Code | `ultracode`    | `CLAUDE.md`  |
| validator  | Codex       | `max`          | `AGENTS.md`  |

The helper is `node .aris/dist/tools/setup-cli.js` (see [integration-contract.md](../shared-references/integration-contract.md)). It owns the draft, the review sheet and the confirmed digest; never edit `.aris/setup-state.json` by hand.

## 1. Task

Both machines need the same `task.md` at the project root. If it is missing, write it with the owner from `.aris/templates/TASK_TEMPLATE.md`. The validator side writes it first; the owner copies it to the worker.

## 2. Review

```bash
node .aris/dist/tools/setup-cli.js review --project .
```

Show the owner `.aris/setup-review.md` in full: every module, field, option, recommendation and open issue at once, in the project language. Do not interview field by field.

The owner answers with several changes in one reply, or edits `.aris/setup-draft.json` directly. Put their changes in a JSON patch (objects merge, lists replace, `null` clears) and refresh:

```bash
node .aris/dist/tools/setup-cli.js review --project . --input patch.json
```

Show the whole sheet again after each refresh. A recommendation becomes a value only when the owner accepts it.

- `environment.secrets` (both roles): only the keys and tokens the environment scripts need, as `{"NAME": "value"}`; `{}` when there are none. Hosts, paths and commands belong in the environment skill (step 5).
- `connection.url` and `connection.token` (worker): printed by `/aris-setup` on the validator machine.
- `validation.benchmark`: the base layer of the benchmark, frozen at setup; validator agents later add layers derived from its tests. Build it with the owner from `.aris/templates/TESTER_FACILITY_CONFIG_TEMPLATE.json` and the runner protocol in `.aris/templates/README.md`; `.aris/templates/tester-benchmark/` is a worked lm-evaluation-harness example. Pin the benchmark source, dataset revision, split and full sample count. The runner must not import anything from a deliverable; it calls the deliverable only through the adapter a validator agent writes under `ARIS_ADAPTER_DIR`.
- `validation.pass_rule`: when one sample, which is one test, passes: a per-sample benchmark metric, an operator (`>=`, `>`, `<=`, `<`, `==`) and a threshold, e.g. `{"metric": "accuracy", "op": ">=", "threshold": 1}`. Results are published as tests passed out of tests run; there is no score or target.
- `validation.hidden_paths`: absolute paths of the hidden samples, labels and references. The independent leak reviewer checks feedback against them and the added layers.
- `validation.limits`: maximum counted submissions (the only stop condition), concurrency, upload size, review timeout, leak-review rewrites and the tests one review may add.
- `validation.agent`: model and mode of the per-submission validator agent, which always runs Codex at `max`. The mode defaults to `full-access`, so the benchmark and the deliverable's documented install can use the network and paths outside the project; `auto` and `auto-review` sandbox them. On Windows `paseo_command` must be `["node", "<Paseo install>\\bin\\paseo"]`; setup rejects the `paseo` shim.
- `validation.service`: how the worker reaches the service.
  - Through the Paseo service proxy: keep `host` at `127.0.0.1`, leave `port` null, and set `public_url` to the proxy URL of the `aris-validation` script.
  - Directly on a private network: set `host` to `0.0.0.0`, a fixed `port`, and `public_url` to `http://<this machine's address>:<port>`. On Windows, allow that port through the firewall: `netsh advfirewall firewall add rule name="ARIS validation" dir=in action=allow protocol=TCP localport=<port>`.

Once a submission has been counted, the base benchmark and the pass rule are frozen and the helper reports any change as an issue. Changing them means a new validator project. A validator project set up before schema version 2 of `.aris/validation/config.json` is not migrated: without counted submissions it runs this setup again after deleting the old `validation.metric` and `validation.leak_check` entries from `.aris/setup-draft.json`; with counted submissions it needs a new validator project.

## 3. Confirm

When the sheet has no issues, show the final `configuration_sha256` and ask the owner to approve that version. Then:

```bash
node .aris/dist/tools/setup-cli.js confirm --project . --digest <configuration_sha256>
```

Any later edit, including to `task.md`, invalidates the confirmation. A request to change something is not approval.

## 4. Apply

```bash
node .aris/dist/tools/setup-cli.js apply --project .
```

Apply writes the role block between the `ARIS ROLE` markers of the role's instruction file and leaves the rest of the file alone, and writes `environment.secrets` to `.aris/environment.json` (mode 0600 where the platform supports it), and adds `.aris/` (and the worker's `.mcp.json`) to `.gitignore`, because they hold credentials. The review sheet shows keys and tokens masked. Create the wiki, the role's long-term memory, if `research-wiki/` is absent: `node .aris/dist/tools/research-wiki.js init research-wiki/`.

**Worker.** Apply adds the `aris-validation` server to `.mcp.json`. Resolve and record the owner's local ARL source checkout and its `experience` worktree in `CLAUDE.md` outside the managed role block, following [the experience contract](../shared-references/experience.md). Preserve existing owner text. Report an unavailable location as pending; do not use the installed `.aris/` directory as an experience repository.

**Validation.** Apply installs the benchmark (setup, healthcheck and smoke must pass), freezes `.aris/validation/config.json`, creates the service token and adds the `aris-validation` service script to `paseo.json`. Then:

1. Give the owner the printed `worker_connection` URL and token for the worker's setup. Send the token over a private channel.
2. Have the owner start the `aris-validation` script from the Paseo workspace.
3. Check it: `node .aris/dist/tools/validation-cli.js status --project .`.

## 5. Environment skill

Write the project's environment skill in apply's `environment_skill_dir` (`<skills>/<project>-environment/`) on the real machine. Find out what you can by inspecting the machine; ask the owner only for what you cannot. The skill holds two things and nothing else:

1. **`SKILL.md`: facts an agent cannot know.** Frontmatter `name: <project>-environment` and a one-line description of where this project's code runs and how its experiments are launched and collected. Then one line per fact: machines and SSH aliases, code, data, checkpoint, result and log paths, environment names and activation, resources and their limits, where the metric lands, verified quirks. Then a table of the scripts with their arguments and output. Do not explain general tools (conda, ssh, git, screen, pip, CUDA), restate defaults, or record guesses, results or research notes.
2. **`scripts/`: fixed procedures.** A procedure that runs the same way every time becomes a script, typically: sync code, prepare the environment, launch a named run, check a run, fetch its logs and results, stop it. Write only what this environment needs. Scripts use `#!/usr/bin/env bash` and `set -euo pipefail`, take arguments instead of being edited, read keys and tokens from `.aris/environment.json` (never inline them), and give every run its own name, log and result path so several experiments can run at once. A procedure that needs a browser uses [browser-act](../browser-act/SKILL.md) after `node .aris/dist/tools/ensure-browser-act.js`; create the browser and any login with the owner now and record the browser id as a fact, because a script cannot ask for approval. Never use Playwright, Selenium or Puppeteer.

Run every script once for real; for a launch, use a small, short run of the project's own entry point. Record only what ran. If a script cannot be made to work, report setup's environment step as incomplete with the real error; do not claim the environment is ready.

Later, when work reveals a new environment fact or a procedure repeated by hand, add it to this skill the same way: a fact line or a verified script.

## 6. Hand off

List the available skills, including the environment skill. Tell the owner to run **`reload-skills`** in their client (or open a fresh session) before starting work, and to run the role's agent in Paseo with the `agent` settings apply reports: the worker as Claude Code at `ultracode`; validator agents are started by the service as Codex at `max`. The worker's changed MCP configuration needs a fresh session; then check that `query` answers.

Finish setup at this handoff. Start research only when the owner requests it.

A failed apply step with an unchanged configuration can be retried as is. A fix that changes the configuration goes back through review and confirm.

# Auto Research Loop Agent Guide

For agents reading this package cold. This file routes you to the right skill; the skill's `SKILL.md` is the specification and wins over anything here.

## What ARIS is

ARIS runs one task as a contest between two machines:

- The **worker** machine has one Claude Code agent (Paseo thinking `ultracode`) with `task.md`, its own environment and its own research wiki. It builds a deliverable and submits it.
- The **validator** machine runs the `aris-validation` service. It owns an append-only benchmark the worker never sees and acts as the worker's adversary: it starts one Codex validator agent (thinking `max`) per submission, which looks for as many real problems as it can, adds tests derived from existing ones, and publishes a verdict, how many tests passed out of how many, and feedback on the problems found (never on the tests) after an independent leak review. Validation ends when the submissions run out.

The two sides share nothing but the service's two MCP tools, `submit` and `query`. Each machine runs official Paseo, so the owner watches both sides' agents in the Paseo app. Everything else (planning, coding, training, debugging, delegating to subagents) is the agent's own work; ARIS adds no workflow for it.

Your role is fixed at installation and written between the `ARIS ROLE` markers of `CLAUDE.md` (worker) or `AGENTS.md` (validation). If there is none, the project is not set up: run `/aris-setup`. The role block is binding: long-term memory (the research wiki and the environment skill, plus `Experience.md` for the worker) is mandatory, short-term tasks go in the todo list, and its numbered steps are followed in order.

## Skills

| Skill | Role | Use it to |
| --- | --- | --- |
| `/aris-setup` | both | Configure this machine through one editable review sheet, then write and verify the project environment skill |
| `/validation-review` | validation | Review one submission (the service starts an agent with it); its `leak-review.md` guides the independent feedback leak reviewer |
| `/research-wiki` | both | Keep long-term memory as `survey`, `idea`, `experiment`, `claim` and `problem` nodes linked by evidence edges: for each problem, what existing work did, what was tried and what was effective or ineffective. Start from the query pack (at most 1000 characters, with node references). The validation wiki records the problems each submission solved or left in place and the testing methods researched |
| `/browser-act` | worker | Read rendered pages and use browser sessions through the external CLI |
| `/<project>-environment` | both | Written by setup: environment facts an agent cannot know, plus verified scripts to sync code, launch named runs (several at once), check them, fetch logs and results and stop them |

Updates and repairs use the standalone installer with the same role; see the [setup guide](SETUP_GUIDE.md#update-or-repair).

Other research skills remain in source but are not shipped in the standalone archive.

## Helpers

Skills call compiled helpers with `node .aris/dist/tools/<helper>.js` from the project root. Which skill uses which helper, and what to do when one fails, is in [integration-contract.md](skills/shared-references/integration-contract.md). Never write a helper's output by hand.

## Where things live

| Path | Owner | Contents |
| --- | --- | --- |
| `task.md` | owner | The task, identical on both machines |
| `.aris/setup-*.json`, `.aris/setup-review.md` | `setup-cli.js` | Draft, review sheet and confirmed configuration |
| `.aris/tester-config.json` | `setup-cli.js` | Frozen base layer of the benchmark (validation) |
| `.aris/validation/` | `validation-cli.js` | Frozen terms, service token, benchmark layers added by reviews (an append-only git repository `benchmark/`, whose head is recorded in `benchmark-head`), submissions and published results (validation) |
| `.mcp.json` | `setup-cli.js` | `aris-validation` server URL and token (worker; keep it out of git) |
| `.aris/environment.json` | `setup-cli.js` | Keys and tokens the environment scripts read (mode 0600; keep it out of git) |
| `<skills>/<project>-environment/` | the role's agent, via `aris-setup` | Environment facts and verified scripts |
| `paseo.json` | `setup-cli.js` | `aris-validation` service script (validation) |
| `research-wiki/` | `research-wiki.js` | Wiki pages, edges, the generated index and query pack |
| Local ARL source checkout: `Experience.md` (reviewed on `main`, new lessons committed to `experience`) | worker agent; the owner merges by pull request | Concise, evidenced lessons reusable across projects; location recorded in worker project instructions, rules in [the experience contract](skills/shared-references/experience.md) |

Architecture and design rationale: [ARIS_ARCHITECTURE_GUIDE.md](ARIS_ARCHITECTURE_GUIDE.md). Installing both machines: [SETUP_GUIDE.md](SETUP_GUIDE.md).

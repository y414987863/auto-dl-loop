# Integration Contract

The standalone ARL package contains aris-setup, validation-review, research-wiki and browser-act skills. Setup writes a project-specific environment skill. Other research skills remain optional source tools.

Skills call ARIS helpers; they never reimplement them. This file lists every
helper and what happens when one is missing or fails.

## Finding a helper

Run helpers from the project root with Node:

```bash
node .aris/dist/tools/<helper>.js ...
```

`.aris/dist/` is the installed runtime. Inside the ARIS package checkout
itself, use `dist/tools/` instead. If the file is missing, stop and tell the
owner to rerun the standalone installer with the same role and project to repair the installation; do not look elsewhere or write the helper's output
by hand.

## Failure rule

A missing helper or a non-zero exit stops the current step. Report the
helper's error and the step it blocked. Do not:

- retry with another tool, source, model or command;
- write the helper's artifact yourself;
- skip the step and report success.

## Helpers

| Helper | Used by | Failure |
| --- | --- | --- |
| `setup-cli.js` | `/aris-setup` | Stop setup. The helper owns the draft, the review and the confirmed digest. |
| `validation-cli.js` | validator machine, `validation-review` | Stop the review. The helper owns submission records, benchmark layers and published results. |
| `research-wiki.js` | `/research-wiki`, literature skills | Stop the wiki write. Never create wiki files by hand. |
| `threat-scan` (inside `research-wiki.js`) | `/research-wiki` | Quarantines strict-scope hits; see [injection-hygiene.md](injection-hygiene.md). |
| `capture-filter.js` | `/research-wiki` | Rewrite or drop the flagged note; see [capture-antipatterns.md](capture-antipatterns.md). |
| `ensure-browser-act.js` | `browser-act`, setup and environment scripts that need a browser | Stop browser work; see [browser-act.md](browser-act.md). |

Add a row here in the same change that makes a skill call a new helper.

# Templates

`/aris-setup` reads these; you do not copy them by hand.

| Template | Used by |
| --- | --- |
| [TASK_TEMPLATE.md](TASK_TEMPLATE.md) | Both roles. Becomes `task.md`, the only statement of the task. |
| [ROLE_WORKER.md](ROLE_WORKER.md), [ROLE_VALIDATOR.md](ROLE_VALIDATOR.md) | Setup writes the matching one between the `ARIS ROLE` markers in `CLAUDE.md` (worker) or `AGENTS.md` (validator). |
| [TESTER_FACILITY_CONFIG_TEMPLATE.json](TESTER_FACILITY_CONFIG_TEMPLATE.json) | Validator role. Starting point for the benchmark's frozen base layer. |
| [tester-benchmark/](tester-benchmark/) | Validator role. A worked lm-evaluation-harness deployment. |

## Benchmark runner protocol

The base layer's `setup`, `healthcheck`, `smoke` and `test` entries are argv arrays with timeouts. Use `python` rather than `python3` so the same config runs on Windows. Runners receive:

| Variable | Value |
| --- | --- |
| `ARIS_TEST_MODE` | `smoke` or `full` |
| `ARIS_TEST_ID`, `ARIS_PROJECT_ID` | Identity of this run |
| `ARIS_ARTIFACT_REF`, `ARIS_ARTIFACT_SHA256` | The unpacked deliverable and its digest |
| `ARIS_ADAPTER_DIR` | The validator agent's adapter for this deliverable |
| `ARIS_TEST_DIR` | Where to write predictions and native benchmark output |
| `ARIS_TEST_OUTPUT` | Where to write the result JSON, only after evaluation finishes |

```json
{
  "artifact_sha256": "<ARIS_ARTIFACT_SHA256>",
  "metrics": {"accuracy": 0.5},
  "samples": [
    {"id": "case-1", "status": "ok", "metrics": {"accuracy": 1}},
    {"id": "case-2", "status": "ok", "metrics": {"accuracy": 0}}
  ],
  "evidence_files": ["predictions.jsonl", "native-results.json"]
}
```

- Each sample is one test. Sample ids are stable and unique; repeats get their own ids. A sample the deliverable crashed on stays in the list with `status: "failed"` and counts as a failed test; the helper rejects runs that drop samples.
- `dataset.expected_samples` is the full protocol count including repeats, never the smoke count.
- Every `ok` sample carries a finite value of the metric named by `validation.pass_rule`; the helper applies the rule to it. Aggregate `metrics` are kept for the record and not published.
- Files listed in the config's `evidence_files` are hashed at setup. Changing one stops the validation service until setup runs again.
- Layers that validator agents add later use the same output format (without `metrics` and `evidence_files`); see the `validation-review` skill.

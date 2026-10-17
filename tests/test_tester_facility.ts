import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonSha256 } from "../src/tools/canonical-json.js";
import { readStateFile, writeStateJsonAtomic } from "../src/tools/state-file.js";
import {
  assertTesterSetupReady,
  checkTesterResult,
  evidenceFile,
  executeTesterJob,
  prepareTesterJob,
  readTesterJob,
  setupTesterFacility,
  testerConfigPath,
  testerResultPath,
  type TesterTestRequest,
} from "../src/tools/tester-facility.js";
import { facilityConfig } from "./helpers/tester-facility-fixture.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-facility-"));
try {
  const config = facilityConfig(root);
  await setupTesterFacility(root, config);
  assertTesterSetupReady(testerConfigPath(root));
  // A second setup with the same config reuses the verified installation.
  await setupTesterFacility(root, config);

  const artifact = path.join(root, "answers.json");
  fs.writeFileSync(artifact, JSON.stringify({ "sample-alpha": "the quick brown fox" }));
  const request: TesterTestRequest = {
    schema_version: 1,
    test_id: "trial-1",
    artifact: { ref: artifact, sha256: evidenceFile(artifact).sha256 },
    mode: "full",
  };
  const dir = path.join(root, "tests", "trial-1");
  prepareTesterJob(dir, testerConfigPath(root), request);
  assert.throws(
    () => prepareTesterJob(dir, testerConfigPath(root), { ...request, mode: "smoke" }),
    /another request/,
  );
  const result = await executeTesterJob(dir);
  assert.equal(result.metrics.score, 0.5);
  assert.equal(readTesterJob(dir).status, "completed");
  assert.deepEqual(await executeTesterJob(dir), result);
  const resultPath = testerResultPath(dir);
  assert.equal(checkTesterResult(resultPath).samples.length, 2);

  // Recompute hashes so these cases exercise semantic checks, not tamper detection.
  const mutantRaw = path.join(dir, "mutant-raw.json"),
    mutantResult = path.join(dir, "mutant-result.json");
  const rawOriginal = readStateFile<any>(path.join(dir, "benchmark-output.json"));
  function rejectsInvalidMeasurement(change: (raw: any, changed: any) => void, code: string) {
    const raw = structuredClone(rawOriginal),
      changed = structuredClone(result) as any;
    change(raw, changed);
    writeStateJsonAtomic(mutantRaw, raw);
    changed.evidence = [evidenceFile(mutantRaw)];
    changed.request_sha256 = canonicalJsonSha256(changed.request);
    writeStateJsonAtomic(mutantResult, changed);
    assert.throws(() => checkTesterResult(mutantResult), new RegExp(code));
  }
  rejectsInvalidMeasurement((_raw, changed) => {
    changed.request.mode = "smoke";
  }, "TESTER_FULL_RESULT_REQUIRED");
  rejectsInvalidMeasurement((raw, changed) => {
    raw.samples.pop();
    changed.sample_count = 1;
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw) => {
    raw.samples[1].id = raw.samples[0].id;
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw) => {
    raw.samples[0].status = "skipped";
  }, "TESTER_COVERAGE_INCOMPLETE");
  rejectsInvalidMeasurement((raw) => {
    raw.samples[0].status = "failed";
  }, "TESTER_RESULT_BINDING_MISMATCH");
  fs.appendFileSync(path.join(dir, "benchmark-output.json"), " ");
  assert.throws(() => checkTesterResult(resultPath), /TESTER_EVIDENCE_CHANGED/);

  // A failed attempt can be retried in the same directory once its cause is fixed.
  const retryDir = path.join(root, "tests", "retry");
  prepareTesterJob(retryDir, testerConfigPath(root), {
    ...request,
    test_id: "retry",
    artifact: { ref: artifact, sha256: "0".repeat(64) },
  });
  await assert.rejects(executeTesterJob(retryDir), /artifact differs/);
  assert.equal(readTesterJob(retryDir).status, "failed");

  // An interrupted job is detected and can run again.
  const staleDir = path.join(root, "tests", "interrupted");
  prepareTesterJob(staleDir, testerConfigPath(root), { ...request, test_id: "interrupted" });
  writeStateJsonAtomic(path.join(staleDir, "job.json"), {
    ...readTesterJob(staleDir),
    status: "running",
    pid: 2147483647,
  });
  assert.equal(readTesterJob(staleDir).status, "failed");
  await executeTesterJob(staleDir);
  assert.equal(readTesterJob(staleDir).status, "completed");

  // Changing a pinned benchmark file invalidates the installation.
  fs.appendFileSync(path.join(config.execution.cwd, "labels.json"), " ");
  assert.throws(() => assertTesterSetupReady(testerConfigPath(root)), /TESTER_EVIDENCE_CHANGED/);
  console.log("tester facility: setup, jobs, retries, result checks and evidence drift passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

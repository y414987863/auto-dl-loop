/**
 * What a validator agent runs against its submission: the base smoke subset
 * while writing the adapter, full runs of every benchmark layer, new layers
 * derived from tests it has run, and finalize, which turns review.json and the
 * leak-reviewed feedback.md into the published result. Test counts are read
 * from the checked runs, never from the agent's text.
 */
import fs from "node:fs";
import path from "node:path";
import { readStateFile } from "../state-file.js";
import { executeTesterJob, prepareTesterJob, testerConfigPath } from "../tester-facility.js";
import { failA1, isRecord } from "../validate.js";
import { readValidationConfig, type ValidationConfig } from "./config.js";
import {
  activeLayers,
  assertBenchmarkIntact,
  BASE_LAYER,
  countLayerRun,
  registerLayer,
  retireLayer,
  runLayer,
  type LayerRun,
} from "./layers.js";
import { clearedFeedback, feedbackText } from "./leak-review.js";
import {
  publish,
  readSubmission,
  serviceSummary,
  submissionDir,
  unpackedDir,
  updateSubmission,
  withSubmissionsLock,
  type SubmissionRecord,
  type SubmissionStatus,
  type TestCounts,
  type Verdict,
} from "./store.js";

const MAX_FEEDBACK_CHARS = 20_000;

function reviewing(root: string, id: string): SubmissionRecord {
  const record = readSubmission(root, id);
  if (record.status !== "reviewing")
    failA1("SUBMISSION_NOT_IN_REVIEW", `submission ${id} is ${record.status}`);
  return record;
}

/** Each attempt gets a new numbered directory: a test directory binds one run for good. */
function nextRunDir(base: string): { dir: string; attempt: number } {
  fs.mkdirSync(base, { recursive: true });
  const attempt = Math.max(0, ...fs.readdirSync(base).map(Number).filter(Number.isInteger)) + 1;
  const dir = path.join(base, String(attempt));
  fs.mkdirSync(dir);
  return { dir, attempt };
}

function artifactOf(root: string, id: string, record: SubmissionRecord) {
  const adapter = path.join(submissionDir(root, id), "adapter");
  return {
    artifact: { ref: unpackedDir(root, id), sha256: record.deliverable!.sha256 },
    ...(fs.existsSync(adapter) ? { adapter_dir: adapter } : {}),
  };
}

/** The base layer's smoke subset, for iterating on the adapter. Nothing is counted. */
export async function runSmoke(projectRoot: string, id: string) {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = reviewing(root, id);
  assertBenchmarkIntact(root, config);
  const { dir, attempt } = nextRunDir(path.join(submissionDir(root, id), "smoke"));
  prepareTesterJob(dir, testerConfigPath(root), {
    schema_version: 1,
    test_id: `${id}-s${attempt}`,
    ...artifactOf(root, id, record),
    mode: "smoke",
  });
  const result = await executeTesterJob(dir);
  return {
    submission_id: id,
    test_dir: dir,
    sample_count: result.sample_count,
    failed_samples: result.failed_samples,
  };
}

/** Full runs of one layer, or of every active layer in order; each run is counted on return. */
export async function evaluate(projectRoot: string, id: string, layer?: string) {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const layers = layer ? [layer] : activeLayers(root);
  if (layer && !activeLayers(root).includes(layer))
    failA1("UNKNOWN_LAYER", `${layer} is not an active benchmark layer`);
  const runs: { layer: string; test_dir: string; tests: TestCounts }[] = [];
  for (const name of layers) {
    const record = reviewing(root, id);
    assertBenchmarkIntact(root, config);
    const { dir, attempt } = nextRunDir(path.join(submissionDir(root, id), "evaluation", name));
    const request = { test_id: `${id}-${name}-e${attempt}`, ...artifactOf(root, id, record) };
    withSubmissionsLock(root, () =>
      updateSubmission(root, id, {
        evaluations: { ...readSubmission(root, id).evaluations, [name]: dir },
      }),
    );
    if (name === BASE_LAYER) {
      prepareTesterJob(dir, testerConfigPath(root), {
        schema_version: 1,
        ...request,
        mode: "full",
      });
      await executeTesterJob(dir);
    } else await runLayer(root, name, dir, request);
    const run = countLayerRun(root, config, name, dir, record.deliverable!.sha256);
    runs.push({ layer: name, test_dir: dir, tests: run.counts });
  }
  return { submission_id: id, runs };
}

/** The latest run of every active layer, counted; a missing or unfinished one is an error. */
function countActiveLayers(
  root: string,
  config: ValidationConfig,
  record: SubmissionRecord,
): Map<string, LayerRun> {
  const runs = new Map<string, LayerRun>();
  const missing = activeLayers(root).filter((layer) => !record.evaluations?.[layer]);
  if (missing.length)
    failA1(
      "EVALUATION_REQUIRED",
      `run evaluate for every active layer first; missing: ${missing.join(", ")}`,
    );
  for (const layer of activeLayers(root))
    runs.set(
      layer,
      countLayerRun(root, config, layer, record.evaluations![layer]!, record.deliverable!.sha256),
    );
  return runs;
}

/**
 * Register a draft layer from inside the submission directory. Its tests may
 * only derive from tests this review has already run on every active layer.
 */
export function extendBenchmark(projectRoot: string, id: string, draft: string) {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = reviewing(root, id);
  assertBenchmarkIntact(root, config);
  const source = path.resolve(draft);
  const relative = path.relative(submissionDir(root, id), source);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    failA1("INVALID_LAYER", "write the draft layer inside the submission directory");
  const known = new Set(
    [...countActiveLayers(root, config, record).values()].flatMap((run) => run.test_ids),
  );
  const layer = registerLayer(root, {
    submission_id: id,
    draft: source,
    known,
    limit: config.limits.max_new_tests_per_review,
  });
  return { submission_id: id, layer, next: `evaluate --layer ${layer.id}` };
}

export function retireBenchmarkLayer(
  projectRoot: string,
  id: string,
  layer: string,
  reason: string,
) {
  const root = path.resolve(projectRoot);
  reviewing(root, id);
  return retireLayer(root, id, layer, reason);
}

function readReview(dir: string): Verdict {
  const file = path.join(dir, "review.json");
  if (!fs.existsSync(file)) failA1("REVIEW_MISSING", `write ${file} first`);
  const review = readStateFile<unknown>(file);
  if (
    !isRecord(review) ||
    !["valid", "cheating", "unusable"].includes(String(review.verdict)) ||
    !Array.isArray(review.reasons) ||
    !review.reasons.length ||
    review.reasons.some((reason) => typeof reason !== "string" || !reason.trim())
  )
    failA1(
      "INVALID_REVIEW",
      'review.json must be {"verdict": "valid"|"cheating"|"unusable", "reasons": ["..."]}',
    );
  return review.verdict as Verdict;
}

export function finalizeSubmission(projectRoot: string, id: string) {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = reviewing(root, id);
  const dir = submissionDir(root, id);
  const verdict = readReview(dir);
  const draft = feedbackText(dir);
  if (draft.length > MAX_FEEDBACK_CHARS)
    failA1("FEEDBACK_TOO_LONG", `keep feedback.md under ${MAX_FEEDBACK_CHARS} characters`);
  // Cheating voids every measured test, and an unusable deliverable has none.
  let tests: TestCounts | null = null;
  if (verdict === "valid") {
    assertBenchmarkIntact(root, config);
    tests = { total: 0, passed: 0, failed: 0 };
    for (const run of countActiveLayers(root, config, record).values()) {
      tests.total += run.counts.total;
      tests.passed += run.counts.passed;
      tests.failed += run.counts.failed;
    }
  }
  const { feedback, withheld } = clearedFeedback(record, draft, config.limits.feedback_attempts);

  return withSubmissionsLock(root, () => {
    reviewing(root, id);
    publish(root, {
      schema_version: 2,
      submission_id: id,
      verdict,
      tests,
      feedback,
      published_at: new Date().toISOString(),
    });
    const status: SubmissionStatus =
      verdict === "valid" ? "tested" : verdict === "cheating" ? "rejected_cheating" : "unusable";
    updateSubmission(root, id, { status });
    return {
      submission_id: id,
      status,
      tests,
      feedback_withheld: withheld,
      service: serviceSummary(root, config),
    };
  });
}

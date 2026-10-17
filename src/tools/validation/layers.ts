/**
 * The benchmark only grows. Layer `base` is the tester facility frozen at
 * setup; every later layer is a set of tests a validator agent derived from
 * tests already in the benchmark and registered with `extend`.
 *
 * Added layers live in a git repository the helper alone commits to. Every
 * commit after the empty root may only add files: one new layer directory with
 * its registry entry, or one retirement note for a registered layer. Because
 * that is checked commit by commit, "the benchmark only grows" is a mechanical
 * property of the history, and the helper's record of the head commit catches
 * a rewritten one. Each run materialises the layer from the commit into its
 * own directory, so a runner may write wherever it likes there.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readStateFile,
  withStateFileLock,
  writeStateFileAtomic,
  writeStateJsonAtomic,
} from "../state-file.js";
import {
  assertTesterSetupReady,
  checkTesterResult,
  execute,
  readTesterFacilityConfig,
  testerConfigPath,
  testerFacilityConfigSha256,
  testerResultPath,
  type TesterCommand,
} from "../tester-facility.js";
import {
  assertNoUnknownFields,
  failA1,
  isRecord,
  requireInteger,
  requireString,
} from "../validate.js";
import { passes, validationDir, type PassRule, type ValidationConfig } from "./config.js";
import type { TestCounts } from "./store.js";

export const BASE_LAYER = "base";
const LAYER_ID = /^inc-\d{3,}$/;
const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Written by the validator agent in its draft; committed with the rest of the layer. */
export const LAYER_SPEC = "layer.json";
/** Written by the helper next to a layer run's raw output. */
const LAYER_RESULT = "layer-result.json";

export interface LayerTest {
  id: string;
  /** Qualified ids (`<layer>:<test id>`) of the existing tests this one varies. */
  derived_from: string[];
  /** The similar scenario: what changed relative to the tests it derives from. */
  variation: string;
  /** How the expected answer was established, so a wrong test cannot fail a right answer. */
  reference_check: string;
}
export interface LayerSpec {
  /** The weakness this layer probes, in the same desensitized terms as feedback. */
  problem: string;
  /** How the variants were produced, naming any external method or tool. */
  method: string;
  /** Runs in a fresh copy of the layer with the same environment as the base runner. */
  run: TesterCommand;
  tests: LayerTest[];
}
export interface LayerRecord {
  id: string;
  problem: string;
  tests: number;
  added_by: string;
  added_at: string;
  retired?: { by: string; at: string; reason: string };
}
export interface LayerRun {
  counts: TestCounts;
  /** Qualified ids of the tests this run covered. */
  test_ids: string[];
}

/** The helper-owned repository of added layers, and the head commit it last wrote. */
export const benchmarkRepo = (root: string): string => path.join(validationDir(root), "benchmark");
const headFile = (root: string): string => path.join(validationDir(root), "benchmark-head");
export function layerDir(root: string, id: string): string {
  if (!LAYER_ID.test(id)) failA1("UNKNOWN_LAYER", `no benchmark layer ${id}`);
  return path.join(benchmarkRepo(root), "layers", id);
}
const registryPath = (id: string) => `registry/${id}.json`;
const retiredPath = (id: string) => `registry/${id}.retired.json`;

/**
 * Run git on the benchmark repository. Bytes are stored exactly as written
 * (no line-ending conversion), and commits are written by the helper, not a
 * person, so they carry a fixed identity and no signature.
 */
function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=aris-validation",
      "-c",
      "user.email=aris-validation@localhost",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
const lines = (text: string): string[] => text.split("\n").filter(Boolean);

function changed(message: string): never {
  failA1("BENCHMARK_CHANGED", `${message}; validation is stopped`);
}

/** Which ids a tree registers and retires, read from its `registry/` file names. */
function registry(repo: string, commit: string): { registered: Set<string>; retired: Set<string> } {
  const registered = new Set<string>(),
    retired = new Set<string>();
  for (const name of lines(git(repo, ["ls-tree", "--name-only", `${commit}`, "registry/"]))) {
    const match = /^registry\/(inc-\d{3,})(\.retired)?\.json$/.exec(name);
    if (!match) continue;
    (match[2] ? retired : registered).add(match[1]!);
  }
  return { registered, retired };
}

/**
 * Check the whole history: an empty root, then single-parent commits that each
 * only add one new layer with its registry entry, or one retirement note.
 */
function assertAppendOnly(root: string): string | null {
  const repo = benchmarkRepo(root);
  const hasRepo = fs.existsSync(path.join(repo, ".git")),
    hasHead = fs.existsSync(headFile(root));
  if (!hasRepo && !hasHead) return null;
  if (!hasRepo || !hasHead) changed("the benchmark repository or its head record is missing");
  const head = fs.readFileSync(headFile(root), "utf8").trim();
  let actual: string;
  try {
    actual = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  } catch {
    changed("the benchmark repository has no readable head");
  }
  if (actual !== head) changed("the benchmark history was rewritten");
  if (git(repo, ["status", "--porcelain", "--untracked-files=no"]).trim())
    changed("registered benchmark files were edited");
  const commits = lines(git(repo, ["rev-list", "--reverse", "--parents", "HEAD"])).map((line) =>
    line.split(" "),
  );
  const [first, ...rest] = commits;
  if (!first || first.length !== 1 || git(repo, ["ls-tree", "-r", first[0]!]).trim())
    changed("the benchmark history does not start from an empty root");
  for (const [commit, ...parents] of rest) {
    if (parents.length !== 1) changed(`benchmark commit ${commit} is not a single-parent commit`);
    const parent = parents[0]!;
    const changes = lines(
      git(repo, [
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--name-status",
        "--no-renames",
        parent,
        commit!,
      ]),
    ).map((line) => line.split("\t"));
    if (!changes.length || changes.some(([status]) => status !== "A"))
      changed(`benchmark commit ${commit} modifies or deletes files`);
    const paths = changes.map(([, file]) => file!);
    const before = registry(repo, parent);
    const retire = /^registry\/(inc-\d{3,})\.retired\.json$/.exec(paths[0]!);
    const id =
      retire?.[1] ??
      /^registry\/(inc-\d{3,})\.json$/.exec(
        paths.find((p) => p.startsWith("registry/")) ?? "",
      )?.[1];
    const ok = retire
      ? paths.length === 1 && before.registered.has(id!) && !before.retired.has(id!)
      : id !== undefined &&
        !before.registered.has(id) &&
        paths.every((file) => file === registryPath(id) || file.startsWith(`layers/${id}/`)) &&
        paths.some((file) => file === `layers/${id}/${LAYER_SPEC}`);
    if (!ok) changed(`benchmark commit ${commit} is not one added layer or one retirement`);
  }
  return head;
}

export function readLayers(root: string): LayerRecord[] {
  const head = assertAppendOnly(root);
  if (!head) return [];
  const repo = benchmarkRepo(root);
  const { registered, retired } = registry(repo, head);
  return [...registered].sort().map((id) => {
    const entry = JSON.parse(git(repo, ["show", `${head}:${registryPath(id)}`])) as LayerRecord;
    return retired.has(id)
      ? { ...entry, retired: JSON.parse(git(repo, ["show", `${head}:${retiredPath(id)}`])) }
      : entry;
  });
}
/** Layers whose tests count, base first. */
export function activeLayers(root: string): string[] {
  return [BASE_LAYER, ...readLayers(root).flatMap((layer) => (layer.retired ? [] : [layer.id]))];
}

/** The base layer and every file it pins are unchanged, and the added layers only grew. */
export function assertBenchmarkIntact(root: string, config: ValidationConfig): void {
  const actual = testerFacilityConfigSha256(readTesterFacilityConfig(testerConfigPath(root)));
  if (actual !== config.tester_config_sha256)
    changed("the installed base benchmark differs from the frozen one");
  assertTesterSetupReady(testerConfigPath(root));
  assertAppendOnly(root);
}

export function parseLayerSpec(value: unknown): LayerSpec {
  if (!isRecord(value)) failA1("INVALID_LAYER", `${LAYER_SPEC} must hold a JSON object`);
  assertNoUnknownFields(value, ["problem", "method", "run", "tests"], "layer");
  const run = value.run;
  if (!isRecord(run) || !Array.isArray(run.argv) || !run.argv.length)
    failA1("INVALID_LAYER", "run must be {argv: [...], timeout_ms}", "layer.run");
  assertNoUnknownFields(run, ["argv", "timeout_ms"], "layer.run");
  if (!Array.isArray(value.tests) || !value.tests.length)
    failA1("INVALID_LAYER", "a layer needs at least one test", "layer.tests");
  const seen = new Set<string>();
  const tests = value.tests.map((test, index) => {
    const at = `layer.tests[${index}]`;
    if (!isRecord(test)) failA1("INVALID_LAYER", "must be an object", at);
    assertNoUnknownFields(test, ["id", "derived_from", "variation", "reference_check"], at);
    const id = requireString(test.id, `${at}.id`);
    if (!TEST_ID.test(id) || seen.has(id))
      failA1("INVALID_LAYER", "test ids must be unique and filename-safe", `${at}.id`);
    seen.add(id);
    if (!Array.isArray(test.derived_from) || !test.derived_from.length)
      failA1(
        "TEST_NOT_DERIVED",
        "every test derives from at least one existing test",
        `${at}.derived_from`,
      );
    return {
      id,
      derived_from: test.derived_from.map((item, i) =>
        requireString(item, `${at}.derived_from[${i}]`),
      ),
      variation: requireString(test.variation, `${at}.variation`),
      reference_check: requireString(test.reference_check, `${at}.reference_check`),
    };
  });
  return {
    problem: requireString(value.problem, "layer.problem"),
    method: requireString(value.method, "layer.method"),
    run: {
      argv: run.argv.map((item, i) => requireString(item, `layer.run.argv[${i}]`)),
      timeout_ms: requireInteger(run.timeout_ms, "layer.run.timeout_ms", 1),
    },
    tests,
  };
}
function committedSpec(root: string, id: string): LayerSpec {
  return parseLayerSpec(
    JSON.parse(git(benchmarkRepo(root), ["show", `HEAD:layers/${id}/${LAYER_SPEC}`])),
  );
}
/** The git tree of a registered layer at the head; a run is bound to it. */
function layerTree(root: string, id: string): string {
  return git(benchmarkRepo(root), ["rev-parse", `HEAD:layers/${id}`]).trim();
}

/** Regular files only, as sorted forward-slash paths relative to `dir`. */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(dir, full).split(path.sep).join("/"));
      else failA1("INVALID_LAYER", `${full} is not a regular file or directory`);
    }
  };
  walk(dir);
  return files.sort();
}

/** Create the repository with its empty root commit the first time a layer is added. */
function ensureRepo(root: string): string {
  const existing = assertAppendOnly(root);
  if (existing) return existing;
  const repo = benchmarkRepo(root);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "benchmark: empty root"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  writeStateFileAtomic(headFile(root), `${head}\n`);
  return head;
}

/**
 * Commit `paths` (already in the working tree) when they stage exactly the
 * `expected` files, check the history and record the head; undo on any failure.
 * The owner's global hooks must not run inside or veto the helper's own commits.
 */
function commitAddition(
  root: string,
  before: string,
  paths: string[],
  expected: string[],
  message: string,
): void {
  const repo = benchmarkRepo(root);
  try {
    git(repo, ["add", "-f", "--", ...paths]);
    const staged = lines(git(repo, ["diff", "--cached", "--name-only", "--no-renames"])).sort();
    if (JSON.stringify(staged) !== JSON.stringify([...expected].sort()))
      failA1("INVALID_LAYER", "the staged files differ from the draft; nothing was registered");
    git(repo, ["commit", "-q", "--no-verify", "-m", message]);
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    writeStateFileAtomic(headFile(root), `${head}\n`);
    assertAppendOnly(root);
  } catch (error) {
    git(repo, ["reset", "-q", "--hard", before]);
    git(repo, ["clean", "-q", "-f", "-d", "--", ...paths]);
    writeStateFileAtomic(headFile(root), `${before}\n`);
    throw error;
  }
}

/**
 * Commit a draft as the next layer. Each test must derive from tests in
 * `known` — the qualified ids the registering review has already run — and one
 * review adds at most `limit` tests.
 */
export function registerLayer(
  root: string,
  request: { submission_id: string; draft: string; known: ReadonlySet<string>; limit: number },
): LayerRecord {
  const draft = path.resolve(request.draft);
  const specFile = path.join(draft, LAYER_SPEC);
  if (!fs.existsSync(specFile)) failA1("INVALID_LAYER", `${specFile} is missing`);
  const spec = parseLayerSpec(readStateFile<unknown>(specFile));
  for (const test of spec.tests)
    for (const parent of test.derived_from)
      if (!request.known.has(parent))
        failA1(
          "TEST_NOT_DERIVED",
          `${test.id} derives from ${parent}, which is not a test this review has run; use <layer>:<test id> of an existing test`,
        );
  const files = listFiles(draft);
  return withStateFileLock(headFile(root), () => {
    const before = ensureRepo(root);
    const layers = readLayers(root);
    const added = layers
      .filter((layer) => layer.added_by === request.submission_id)
      .reduce((sum, layer) => sum + layer.tests, 0);
    if (added + spec.tests.length > request.limit)
      failA1(
        "TEST_LIMIT",
        `one review adds at most ${request.limit} tests; this one has ${request.limit - added} left`,
      );
    const last = layers.at(-1);
    const id = `inc-${String((last ? Number(last.id.slice(4)) : 0) + 1).padStart(3, "0")}`;
    const repo = benchmarkRepo(root);
    fs.cpSync(draft, layerDir(root, id), { recursive: true, errorOnExist: true, force: false });
    const record: LayerRecord = {
      id,
      problem: spec.problem,
      tests: spec.tests.length,
      added_by: request.submission_id,
      added_at: new Date().toISOString(),
    };
    writeStateJsonAtomic(path.join(repo, registryPath(id)), record);
    commitAddition(
      root,
      before,
      [`layers/${id}`, registryPath(id)],
      [...files.map((file) => `layers/${id}/${file}`), registryPath(id)],
      `extend ${id} (${request.submission_id})`,
    );
    return record;
  });
}

export function retireLayer(root: string, by: string, id: string, reason: string): LayerRecord {
  if (!reason.trim()) failA1("INVALID_VALUE", "say why the layer is retired", "reason");
  return withStateFileLock(headFile(root), () => {
    const before = assertAppendOnly(root);
    const layer = readLayers(root).find((item) => item.id === id);
    if (!before || !layer)
      failA1("UNKNOWN_LAYER", `no benchmark layer ${id}; the base layer cannot be retired`);
    if (layer.retired) failA1("LAYER_RETIRED", `${id} was already retired`);
    const retired = { by, at: new Date().toISOString(), reason: reason.trim() };
    writeStateJsonAtomic(path.join(benchmarkRepo(root), retiredPath(id)), retired);
    commitAddition(root, before, [retiredPath(id)], [retiredPath(id)], `retire ${id} (${by})`);
    return { ...layer, retired };
  });
}

/** Pass or fail for each raw sample; a sample the runner marked failed is a failed test. */
function countSamples(layer: string, samples: Record<string, unknown>[], rule: PassRule): LayerRun {
  let passed = 0;
  for (const sample of samples) {
    if (sample.status !== "ok") continue;
    const value = isRecord(sample.metrics) ? sample.metrics[rule.metric] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value))
      failA1("TESTER_SCORE_MISSING", `sample ${String(sample.id)} has no ${rule.metric} value`);
    if (passes(rule, value)) passed++;
  }
  return {
    counts: { total: samples.length, passed, failed: samples.length - passed },
    test_ids: samples.map((sample) => `${layer}:${String(sample.id)}`),
  };
}

function rawSamples(raw: unknown, expected: string[]): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw.samples))
    failA1("INVALID_TESTER_RESULT", "the layer runner must write {artifact_sha256, samples}");
  const ids = new Set<string>();
  for (const sample of raw.samples)
    if (
      !isRecord(sample) ||
      typeof sample.id !== "string" ||
      ids.has(sample.id) ||
      !["ok", "failed"].includes(String(sample.status))
    )
      failA1("INVALID_TESTER_RESULT", "samples must have unique ids and status ok or failed");
    else ids.add(sample.id);
  if (ids.size !== expected.length || expected.some((id) => !ids.has(id)))
    failA1("TESTER_COVERAGE_INCOMPLETE", "the layer run must cover exactly the layer's tests");
  return raw.samples as Record<string, unknown>[];
}

const sha256File = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Check a git tree out into `dest` through a private index, leaving the repository untouched. */
function materialise(root: string, tree: string, dest: string): void {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aris-layer-")), "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    git(benchmarkRepo(root), ["read-tree", tree], env);
    fs.mkdirSync(dest, { recursive: true });
    git(benchmarkRepo(root), ["--work-tree", dest, "checkout-index", "-a", "-f"], env);
  } finally {
    fs.rmSync(path.dirname(index), { recursive: true, force: true });
  }
}

/** Run one registered layer against a deliverable in `dir`, from a fresh copy of its commit. */
export async function runLayer(
  root: string,
  id: string,
  dir: string,
  request: { test_id: string; artifact: { ref: string; sha256: string }; adapter_dir?: string },
): Promise<void> {
  const layer = readLayers(root).find((item) => item.id === id);
  if (!layer) failA1("UNKNOWN_LAYER", `no benchmark layer ${id}`);
  if (layer.retired) failA1("LAYER_RETIRED", `${id} is retired`);
  const tree = layerTree(root, id);
  const cwd = path.join(dir, "layer");
  materialise(root, tree, cwd);
  const spec = committedSpec(root, id);
  const output = path.join(dir, "benchmark-output.json");
  await execute(
    { cwd, env: {} },
    spec.run,
    {
      ARIS_TEST_MODE: "full",
      ARIS_TEST_ID: request.test_id,
      ARIS_TEST_OUTPUT: output,
      ARIS_TEST_DIR: dir,
      ARIS_LAYER_DIR: cwd,
      ARIS_ARTIFACT_REF: request.artifact.ref,
      ARIS_ARTIFACT_SHA256: request.artifact.sha256,
      ...(request.adapter_dir ? { ARIS_ADAPTER_DIR: request.adapter_dir } : {}),
    },
    path.join(dir, "test.log"),
  );
  const raw = readStateFile<Record<string, unknown>>(output);
  if (raw.artifact_sha256 !== request.artifact.sha256)
    failA1("TESTER_RESULT_BINDING_MISMATCH", "runner must identify the tested artifact digest");
  rawSamples(
    raw,
    spec.tests.map((test) => test.id),
  );
  writeStateJsonAtomic(path.join(dir, LAYER_RESULT), {
    schema_version: 1,
    layer: id,
    layer_tree: tree,
    artifact_sha256: request.artifact.sha256,
    output_sha256: sha256File(output),
    completed_at: new Date().toISOString(),
  });
}

/** Re-check a finished run of `layer` on the deliverable `artifactSha256` and count its tests. */
export function countLayerRun(
  root: string,
  config: ValidationConfig,
  layer: string,
  dir: string,
  artifactSha256: string,
): LayerRun {
  if (layer === BASE_LAYER) {
    if (!fs.existsSync(testerResultPath(dir)))
      failA1("EVALUATION_INCOMPLETE", `the run in ${dir} did not finish; evaluate again`);
    const { result, samples } = checkTesterResult(testerResultPath(dir));
    if (result.config_sha256 !== config.tester_config_sha256)
      changed("the run used a different base benchmark");
    if (result.request.artifact.sha256 !== artifactSha256)
      failA1("EVALUATION_MISMATCH", "the run tested a different deliverable");
    return countSamples(layer, samples, config.pass_rule);
  }
  if (!readLayers(root).some((item) => item.id === layer))
    failA1("UNKNOWN_LAYER", `no benchmark layer ${layer}`);
  const resultFile = path.join(dir, LAYER_RESULT);
  if (!fs.existsSync(resultFile))
    failA1("EVALUATION_INCOMPLETE", `the run in ${dir} did not finish; evaluate again`);
  const result = readStateFile<Record<string, unknown>>(resultFile);
  const output = path.join(dir, "benchmark-output.json");
  if (
    result.layer !== layer ||
    result.layer_tree !== layerTree(root, layer) ||
    !fs.existsSync(output) ||
    result.output_sha256 !== sha256File(output)
  )
    failA1("TESTER_RESULT_BINDING_MISMATCH", `the run in ${dir} does not match layer ${layer}`);
  if (result.artifact_sha256 !== artifactSha256)
    failA1("EVALUATION_MISMATCH", "the run tested a different deliverable");
  const samples = rawSamples(
    readStateFile<unknown>(output),
    committedSpec(root, layer).tests.map((test) => test.id),
  );
  return countSamples(layer, samples, config.pass_rule);
}

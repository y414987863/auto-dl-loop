/** Frozen benchmark facility: setup once, then run deterministic, re-checkable test jobs. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { canonicalJsonSha256 } from "./canonical-json.js";
import {
  acquireStateFileLock,
  releaseStateFileLock,
  readStateFile,
  withStateFileLock,
  writeStateJsonAtomic,
} from "./state-file.js";
import {
  assertIdentifier,
  assertSha256,
  assertNoUnknownFields,
  isRecord,
  requireInteger,
  requireString,
  failA1,
} from "./validate.js";

export interface TesterCommand {
  argv: string[];
  timeout_ms: number;
}
export interface TesterFacilityConfig {
  schema_version: 1;
  mode: "tester_facility";
  tester_id: string;
  project_id: string;
  version: string;
  benchmark: { name: string; source: string; revision: string };
  dataset: { name: string; revision: string; split: string; expected_samples: number };
  metrics: Array<{
    name: string;
    direction: "higher_better" | "lower_better";
    aggregation: "mean" | "sum" | "external";
  }>;
  execution: { cwd: string; env: Record<string, string> };
  setup: TesterCommand[];
  healthcheck: TesterCommand;
  smoke: TesterCommand;
  test: TesterCommand;
  evidence_files: string[];
}
export interface TesterEvidence {
  path: string;
  sha256: string;
}
export interface TesterSetupReceipt {
  schema_version: 1;
  config_sha256: string;
  status: "ready";
  evidence: TesterEvidence[];
  completed_at: string;
}
export interface TesterTestRequest {
  schema_version: 1;
  test_id: string;
  /** What is under test: a file or directory plus the digest the runner must echo back. */
  artifact: { ref: string; sha256: string };
  /** Directory the runner loads to drive the artifact; written by whoever prepares the test. */
  adapter_dir?: string;
  mode: "full" | "smoke";
}
export interface TesterTestResult {
  schema_version: 1;
  test_id: string;
  request: TesterTestRequest;
  request_sha256: string;
  config: TesterFacilityConfig;
  config_sha256: string;
  status: "completed";
  metrics: Record<string, number>;
  sample_count: number;
  failed_samples: number;
  evidence: TesterEvidence[];
  completed_at: string;
}
export interface TesterJob {
  schema_version: 1;
  request: TesterTestRequest;
  request_sha256: string;
  config: TesterFacilityConfig;
  config_sha256: string;
  config_path: string;
  status: "pending" | "running" | "completed" | "failed";
  pid: number | null;
  attempt: number;
  error: string | null;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) failA1("INVALID_TESTER_FACILITY", `${label} must be an array`);
  return value.map((v, i) => requireString(v, `${label}[${i}]`));
}
function command(value: unknown, label: string): TesterCommand {
  if (!isRecord(value)) failA1("INVALID_TESTER_FACILITY", `${label} must be a command`);
  if (!Array.isArray(value.argv) || value.argv.some((v) => typeof v !== "string"))
    failA1("INVALID_TESTER_FACILITY", `${label}.argv must contain strings`);
  assertNoUnknownFields(value, ["argv", "timeout_ms"], label);
  const argv = value.argv as string[];
  if (!argv.length || !argv[0])
    failA1("INVALID_TESTER_FACILITY", `${label}.argv must not be empty`);
  return { argv, timeout_ms: requireInteger(value.timeout_ms, `${label}.timeout_ms`, 1) };
}
export function validateTesterFacilityConfig(value: unknown): TesterFacilityConfig {
  if (!isRecord(value) || value.schema_version !== 1 || value.mode !== "tester_facility")
    failA1("INVALID_TESTER_FACILITY", "run /aris-setup to create a tester facility configuration");
  assertNoUnknownFields(
    value,
    [
      "schema_version",
      "mode",
      "tester_id",
      "project_id",
      "version",
      "benchmark",
      "dataset",
      "metrics",
      "execution",
      "setup",
      "healthcheck",
      "smoke",
      "test",
      "evidence_files",
    ],
    "tester_facility",
  );
  for (const key of ["benchmark", "dataset", "execution"])
    if (!isRecord(value[key])) failA1("INVALID_TESTER_FACILITY", `${key} must be an object`);
  const b = value.benchmark as Record<string, unknown>,
    d = value.dataset as Record<string, unknown>,
    e = value.execution as Record<string, unknown>;
  assertNoUnknownFields(b, ["name", "source", "revision"], "benchmark");
  assertNoUnknownFields(d, ["name", "revision", "split", "expected_samples"], "dataset");
  assertNoUnknownFields(e, ["cwd", "env"], "execution");
  const cwd = requireString(e.cwd, "execution.cwd");
  if (!path.isAbsolute(cwd)) failA1("INVALID_TESTER_FACILITY", "execution.cwd must be absolute");
  const env: Record<string, string> = {};
  if (!isRecord(e.env)) failA1("INVALID_TESTER_FACILITY", "execution.env must be an object");
  for (const [key, item] of Object.entries(e.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      failA1("INVALID_TESTER_FACILITY", "invalid environment key");
    if (typeof item !== "string")
      failA1("INVALID_TESTER_FACILITY", "environment values must be strings");
    env[key] = item;
  }
  if (!Array.isArray(value.metrics) || !value.metrics.length || !Array.isArray(value.setup))
    failA1("INVALID_TESTER_FACILITY", "metrics and setup must be declared");
  const metrics = value.metrics.map((m) => {
    if (
      !isRecord(m) ||
      !["higher_better", "lower_better"].includes(String(m.direction)) ||
      !["mean", "sum", "external"].includes(String(m.aggregation))
    )
      failA1("INVALID_TESTER_FACILITY", "invalid metric definition");
    assertNoUnknownFields(m, ["name", "direction", "aggregation"], "metric");
    return {
      name: assertIdentifier(m.name, "metric.name"),
      direction: m.direction,
      aggregation: m.aggregation,
    } as TesterFacilityConfig["metrics"][number];
  });
  if (new Set(metrics.map((m) => m.name)).size !== metrics.length)
    failA1("INVALID_TESTER_FACILITY", "duplicate metrics");
  const evidenceFiles = strings(value.evidence_files, "evidence_files");
  if (!evidenceFiles.length)
    failA1(
      "INVALID_TESTER_FACILITY",
      "pin the runner, configuration and data manifest in evidence_files",
    );
  return {
    schema_version: 1,
    mode: "tester_facility",
    tester_id: assertIdentifier(value.tester_id, "tester_id"),
    project_id: assertIdentifier(value.project_id, "project_id"),
    version: assertIdentifier(value.version, "version"),
    benchmark: {
      name: requireString(b.name, "benchmark.name"),
      source: requireString(b.source, "benchmark.source"),
      revision: requireString(b.revision, "benchmark.revision"),
    },
    dataset: {
      name: requireString(d.name, "dataset.name"),
      revision: requireString(d.revision, "dataset.revision"),
      split: requireString(d.split, "dataset.split"),
      expected_samples: requireInteger(d.expected_samples, "dataset.expected_samples", 1),
    },
    metrics,
    execution: { cwd, env },
    setup: value.setup.map((v, i) => command(v, `setup[${i}]`)),
    healthcheck: command(value.healthcheck, "healthcheck"),
    smoke: command(value.smoke, "smoke"),
    test: command(value.test, "test"),
    evidence_files: evidenceFiles,
  };
}
export function testerFacilityConfigSha256(value: TesterFacilityConfig): string {
  return canonicalJsonSha256(validateTesterFacilityConfig(value));
}
export const testerConfigPath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "tester-config.json");
export function readTesterFacilityConfig(file: string): TesterFacilityConfig {
  return validateTesterFacilityConfig(readStateFile(file));
}
export function evidenceFile(file: string): TesterEvidence {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    failA1("TESTER_EVIDENCE_MISSING", resolved);
  return {
    path: resolved,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(resolved)).digest("hex"),
  };
}
function verifyEvidence(evidence: TesterEvidence[]): void {
  if (!Array.isArray(evidence) || !evidence.length)
    failA1("TESTER_EVIDENCE_MISSING", "no evidence recorded");
  for (const item of evidence)
    if (evidenceFile(item.path).sha256 !== assertSha256(item.sha256, "evidence.sha256"))
      failA1("TESTER_EVIDENCE_CHANGED", item.path);
}

/** Kill the command and everything it started; Windows has no process groups to signal. */
function killTree(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, signal);
  } catch {}
}
/** Run one command in `execution.cwd`, appending its output to `logPath`; any failure throws. */
export async function execute(
  execution: TesterFacilityConfig["execution"],
  cmd: TesterCommand,
  env: Record<string, string>,
  logPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "a");
  const [executable, ...argv] = cmd.argv as [string, ...string[]];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, argv, {
        cwd: execution.cwd,
        env: { ...process.env, ...execution.env, ...env },
        stdio: ["ignore", log, log],
        // A detached POSIX child leads its own process group, so killTree reaches its children.
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid!, "SIGTERM");
      }, cmd.timeout_ms);
      const killTimer = setTimeout(() => {
        if (timedOut) killTree(child.pid!, "SIGKILL");
      }, cmd.timeout_ms + 5000);
      child.on("error", (err) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (code === 0 && !timedOut) {
          resolve();
        } else {
          reject(
            new Error(`${executable}: ${timedOut ? "timeout" : `exit ${code}`} (see ${logPath})`),
          );
        }
      });
    });
  } finally {
    fs.closeSync(log);
  }
}
export function assertTesterSetupReady(configPath: string): TesterSetupReceipt {
  const config = readTesterFacilityConfig(configPath);
  if (!fs.existsSync(`${configPath}.setup.json`))
    failA1("TESTER_SETUP_REQUIRED", "run /aris-setup to initialize tester facilities");
  const receipt = readStateFile<TesterSetupReceipt>(`${configPath}.setup.json`);
  if (
    receipt.schema_version !== 1 ||
    receipt.status !== "ready" ||
    receipt.config_sha256 !== testerFacilityConfigSha256(config) ||
    !Array.isArray(receipt.evidence) ||
    receipt.evidence.length !== config.evidence_files.length
  )
    failA1("TESTER_SETUP_REQUIRED", "run /aris-setup before testing");
  verifyEvidence(receipt.evidence);
  return receipt;
}
export async function setupTesterFacility(
  root: string,
  value: unknown,
): Promise<TesterFacilityConfig> {
  const lockPath = `${testerConfigPath(root)}.setup`,
    token = acquireStateFileLock(lockPath);
  try {
    return await setupTesterFacilityUnlocked(root, value);
  } finally {
    releaseStateFileLock(lockPath, token);
  }
}
async function setupTesterFacilityUnlocked(
  root: string,
  value: unknown,
): Promise<TesterFacilityConfig> {
  const config = validateTesterFacilityConfig(value),
    file = testerConfigPath(root),
    log = `${file}.setup.log`;
  fs.mkdirSync(config.execution.cwd, { recursive: true });
  // A same-version setup is reusable only while all installed evidence still matches.
  if (fs.existsSync(file) && fs.existsSync(`${file}.setup.json`)) {
    try {
      if (
        testerFacilityConfigSha256(readTesterFacilityConfig(file)) ===
        testerFacilityConfigSha256(config)
      ) {
        assertTesterSetupReady(file);
        return config;
      }
    } catch {}
  }
  fs.rmSync(`${file}.setup.json`, { force: true });
  for (const cmd of config.setup) await execute(config.execution, cmd, {}, log);
  await execute(config.execution, config.healthcheck, {}, log);
  await execute(config.execution, config.smoke, { ARIS_TEST_MODE: "smoke" }, log);
  const evidence = config.evidence_files.map((source) =>
    evidenceFile(path.resolve(config.execution.cwd, source)),
  );
  writeStateJsonAtomic(file, config);
  writeStateJsonAtomic(`${file}.setup.json`, {
    schema_version: 1,
    config_sha256: testerFacilityConfigSha256(config),
    status: "ready",
    evidence,
    completed_at: new Date().toISOString(),
  } satisfies TesterSetupReceipt);
  return config;
}
export function validateTesterTestRequest(value: unknown): TesterTestRequest {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.artifact) ||
    !["full", "smoke"].includes(String(value.mode))
  )
    failA1("INVALID_TESTER_REQUEST", "invalid test request");
  assertNoUnknownFields(
    value,
    ["schema_version", "test_id", "artifact", "adapter_dir", "mode"],
    "request",
  );
  assertNoUnknownFields(value.artifact, ["ref", "sha256"], "artifact");
  const testId = assertIdentifier(value.test_id, "test_id");
  // Identifiers used as filesystem components must also forbid slashes and traversal.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(testId))
    failA1("INVALID_TESTER_REQUEST", "test_id must be a filename-safe identifier");
  let adapterDir: string | undefined;
  if (value.adapter_dir !== undefined) {
    adapterDir = requireString(value.adapter_dir, "adapter_dir");
    if (!path.isAbsolute(adapterDir))
      failA1("INVALID_TESTER_REQUEST", "adapter_dir must be absolute");
  }
  return {
    schema_version: 1,
    test_id: testId,
    artifact: {
      ref: requireString(value.artifact.ref, "artifact.ref"),
      sha256: assertSha256(value.artifact.sha256, "artifact.sha256"),
    },
    ...(adapterDir === undefined ? {} : { adapter_dir: adapterDir }),
    mode: value.mode as "full" | "smoke",
  };
}
const jobFile = (dir: string): string => path.join(dir, "job.json");
export const testerResultPath = (dir: string): string => path.join(dir, "test-result.json");

/** Bind a request to the current frozen setup inside `dir`; replaying the same request reuses it. */
export function prepareTesterJob(dir: string, configPath: string, value: unknown): TesterJob {
  const config = readTesterFacilityConfig(configPath);
  assertTesterSetupReady(configPath);
  const request = validateTesterTestRequest(value),
    file = jobFile(dir);
  return withStateFileLock(file, () => {
    if (fs.existsSync(file)) {
      const job = readStateFile<TesterJob>(file);
      if (
        job.request_sha256 !== canonicalJsonSha256(request) ||
        job.config_sha256 !== testerFacilityConfigSha256(config)
      )
        failA1("TESTER_JOB_CONFLICT", "this test already binds another request or configuration");
      return job;
    }
    const job: TesterJob = {
      schema_version: 1,
      request,
      request_sha256: canonicalJsonSha256(request),
      config,
      config_sha256: testerFacilityConfigSha256(config),
      config_path: path.resolve(configPath),
      status: "pending",
      pid: null,
      attempt: 0,
      error: null,
    };
    writeStateJsonAtomic(file, job);
    return job;
  });
}
export function readTesterJob(dir: string): TesterJob {
  const file = jobFile(dir);
  return withStateFileLock(file, () => {
    const job = readStateFile<TesterJob>(file);
    if (job.status === "running" && job.pid !== null) {
      try {
        process.kill(job.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") {
          job.status = "failed";
          job.error = "test process interrupted; run it again to retry";
          job.pid = null;
          writeStateJsonAtomic(file, job);
        }
      }
    }
    return job;
  });
}
export async function executeTesterJob(dir: string): Promise<TesterTestResult> {
  const file = jobFile(dir);
  const job = withStateFileLock(file, () => {
    const j = readStateFile<TesterJob>(file);
    if (j.status === "completed") return j;
    if (j.status === "running")
      failA1("TESTER_JOB_RUNNING", "query the running job instead of starting another");
    assertTesterSetupReady(j.config_path);
    if (testerFacilityConfigSha256(readTesterFacilityConfig(j.config_path)) !== j.config_sha256)
      failA1("TESTER_CONFIG_CHANGED", "setup changed; create a new test");
    j.status = "running";
    j.pid = process.pid;
    j.attempt++;
    j.error = null;
    writeStateJsonAtomic(file, j);
    return j;
  });
  if (job.status === "completed") return readStateFile<TesterTestResult>(testerResultPath(dir));
  try {
    const setup = assertTesterSetupReady(job.config_path);
    const verifyInstalled = () => {
      for (const [i, source] of job.config.evidence_files.entries())
        if (
          evidenceFile(path.resolve(job.config.execution.cwd, source)).sha256 !==
          setup.evidence[i]!.sha256
        )
          failA1("TESTER_CONFIG_CHANGED", `installed benchmark evidence changed: ${source}`);
    };
    verifyInstalled();
    const { artifact } = job.request;
    if (
      fs.existsSync(artifact.ref) &&
      fs.statSync(artifact.ref).isFile() &&
      evidenceFile(artifact.ref).sha256 !== artifact.sha256
    )
      failA1("TESTER_ARTIFACT_CHANGED", "tested artifact differs from the request");
    const output = path.join(dir, "benchmark-output.json"),
      log = path.join(dir, "test.log");
    fs.rmSync(output, { force: true });
    const env: Record<string, string> = {
      ARIS_TEST_MODE: job.request.mode,
      ARIS_TEST_ID: job.request.test_id,
      ARIS_PROJECT_ID: job.config.project_id,
      ARIS_TEST_OUTPUT: output,
      ARIS_TEST_DIR: dir,
      ARIS_ARTIFACT_REF: artifact.ref,
      ARIS_ARTIFACT_SHA256: artifact.sha256,
      ...(job.request.adapter_dir === undefined
        ? {}
        : { ARIS_ADAPTER_DIR: job.request.adapter_dir }),
    };
    await execute(job.config.execution, job.config.healthcheck, env, log);
    await execute(
      job.config.execution,
      job.request.mode === "full" ? job.config.test : job.config.smoke,
      env,
      log,
    );
    verifyInstalled();
    const raw = readStateFile<Record<string, unknown>>(output);
    if (raw.artifact_sha256 !== artifact.sha256)
      failA1("TESTER_RESULT_BINDING_MISMATCH", "runner must identify the tested artifact digest");
    if (!isRecord(raw.metrics) || !Array.isArray(raw.samples) || !Array.isArray(raw.evidence_files))
      failA1("INVALID_TESTER_RESULT", "runner must provide metrics, samples and evidence_files");
    const names = job.config.metrics.map((m) => m.name).sort();
    if (Object.keys(raw.metrics).sort().join() !== names.join())
      failA1("INVALID_TESTER_RESULT", "metric set differs from setup");
    for (const val of Object.values(raw.metrics))
      if (typeof val !== "number" || !Number.isFinite(val))
        failA1("INVALID_TESTER_RESULT", "metrics must be finite");
    const seen = new Set<string>();
    let failed = 0;
    for (const sample of raw.samples) {
      if (
        !isRecord(sample) ||
        typeof sample.id !== "string" ||
        !sample.id ||
        seen.has(sample.id) ||
        !["ok", "failed"].includes(String(sample.status))
      )
        failA1("INVALID_TESTER_RESULT", "samples must have unique ids and explicit status");
      seen.add(sample.id);
      if (sample.status === "failed") failed++;
    }
    const evidence = [evidenceFile(output), evidenceFile(log), ...setup.evidence];
    for (const source of strings(raw.evidence_files, "runner.evidence_files"))
      evidence.push(evidenceFile(path.resolve(dir, source)));
    const result: TesterTestResult = {
      schema_version: 1,
      test_id: job.request.test_id,
      request: job.request,
      request_sha256: job.request_sha256,
      config: job.config,
      config_sha256: job.config_sha256,
      status: "completed",
      metrics: raw.metrics as Record<string, number>,
      sample_count: raw.samples.length,
      failed_samples: failed,
      evidence,
      completed_at: new Date().toISOString(),
    };
    writeStateJsonAtomic(testerResultPath(dir), result);
    job.status = "completed";
    job.pid = null;
    writeStateJsonAtomic(file, job);
    return result;
  } catch (e) {
    job.status = "failed";
    job.pid = null;
    job.error = String(e);
    writeStateJsonAtomic(file, job);
    throw e;
  }
}
/**
 * Re-check a completed full run against its raw evidence: the binding to request and setup,
 * unchanged benchmark files, and every expected sample present once with an explicit status.
 * A failed sample is a test the artifact failed, not a broken run; the caller counts it.
 */
export function checkTesterResult(resultPath: string): {
  result: TesterTestResult;
  samples: Record<string, unknown>[];
} {
  const result = readStateFile<TesterTestResult>(resultPath);
  const request = validateTesterTestRequest(result.request),
    config = validateTesterFacilityConfig(result.config);
  if (result.status !== "completed" || request.mode !== "full")
    failA1("TESTER_FULL_RESULT_REQUIRED", "only completed full benchmark results count");
  if (
    result.test_id !== request.test_id ||
    result.request_sha256 !== canonicalJsonSha256(request) ||
    result.config_sha256 !== testerFacilityConfigSha256(config)
  )
    failA1("TESTER_RESULT_BINDING_MISMATCH", "result does not match its request and setup");
  verifyEvidence(result.evidence);
  const raw = readStateFile<Record<string, unknown>>(result.evidence[0]!.path);
  if (raw.artifact_sha256 !== request.artifact.sha256)
    failA1("TESTER_RESULT_BINDING_MISMATCH", "raw results identify a different artifact");
  if (
    !Array.isArray(raw.samples) ||
    raw.samples.length !== config.dataset.expected_samples ||
    result.sample_count !== raw.samples.length
  )
    failA1("TESTER_COVERAGE_INCOMPLETE", "every expected sample must be in the result");
  const ids = new Set<string>();
  let failed = 0;
  for (const sample of raw.samples) {
    if (
      !isRecord(sample) ||
      typeof sample.id !== "string" ||
      !sample.id ||
      ids.has(sample.id) ||
      !["ok", "failed"].includes(String(sample.status))
    )
      failA1("TESTER_COVERAGE_INCOMPLETE", "invalid or duplicated sample");
    ids.add(sample.id);
    if (sample.status === "failed") failed++;
  }
  if (failed !== result.failed_samples)
    failA1("TESTER_RESULT_BINDING_MISMATCH", "failed sample count differs from raw evidence");
  return { result, samples: raw.samples as Record<string, unknown>[] };
}

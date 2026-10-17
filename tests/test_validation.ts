import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { writeStateJsonAtomic } from "../src/tools/state-file.js";
import {
  readTesterFacilityConfig,
  setupTesterFacility,
  testerConfigPath,
  testerFacilityConfigSha256,
} from "../src/tools/tester-facility.js";
import {
  ensureValidationToken,
  validationConfigPath,
  type ValidationConfig,
} from "../src/tools/validation/config.js";
import {
  leakReviewRun,
  paseoDispatcher,
  paseoRunArgv,
  reviewRun,
} from "../src/tools/validation/dispatch.js";
import { benchmarkRepo, layerDir } from "../src/tools/validation/layers.js";
import { requestLeakReview } from "../src/tools/validation/leak-review.js";
import {
  evaluate,
  extendBenchmark,
  finalizeSubmission,
  retireBenchmarkLayer,
  runSmoke,
} from "../src/tools/validation/review.js";
import { startValidationService } from "../src/tools/validation/server.js";
import {
  readSubmission,
  serviceSummary,
  submissionDir,
  updateSubmission,
  withSubmissionsLock,
} from "../src/tools/validation/store.js";
import { unzipDeliverable } from "../src/tools/validation/zip.js";
import { facilityConfig } from "./helpers/tester-facility-fixture.js";

interface ZipEntry {
  name: string;
  data?: string;
  /** Stored instead of deflated. */
  stored?: boolean;
  /** Unix mode recorded by a Unix zip tool, e.g. a symlink. */
  unixMode?: number;
  /** Size to declare instead of the real one. */
  declaredSize?: number;
}

/** Minimal zip writer, enough to produce both honest and hostile archives. */
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data ?? "", "utf8");
    const data = entry.stored ? raw : zlib.deflateRawSync(raw);
    const crc = (zlib as unknown as { crc32(data: Buffer): number }).crc32(raw);
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((entry.unixMode ? 3 : 0) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.stored ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const USAGE = { name: "USAGE.md", data: "# Usage\nRead answers.json.\n" };
const deliverable = (answers: Record<string, string>, prefix = "") =>
  zip([
    { ...USAGE, name: `${prefix}USAGE.md` },
    { name: `${prefix}answers.json`, data: JSON.stringify(answers), stored: true },
  ]);
const PERFECT = { "sample-alpha": "the quick brown fox", "sample-bravo": "jumps over" };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aris-validation-"));
try {
  // --- unzip ---
  const limits = { max_files: 10, max_unpacked_bytes: 10_000 };
  let n = 0;
  async function unpack(archive: Buffer) {
    const file = path.join(root, `case-${++n}.zip`);
    fs.writeFileSync(file, archive);
    return unzipDeliverable(file, path.join(root, `case-${n}`), limits);
  }
  for (const [label, entries, pattern] of [
    ["traversal", [USAGE, { name: "../evil.txt", data: "x" }], /escapes/],
    ["backslash traversal", [USAGE, { name: "a\\..\\..\\evil.txt", data: "x" }], /escapes/],
    ["drive path", [USAGE, { name: "C:/evil.txt", data: "x" }], /absolute/],
    ["symlink", [USAGE, { name: "link", data: "/etc", unixMode: 0o120777 }], /symbolic link/],
    ["case duplicate", [USAGE, { name: "usage.MD", data: "x" }], /duplicate/],
    ["reserved name", [USAGE, { name: "con.txt", data: "x" }], /reserved/],
    ["missing USAGE.md", [{ name: "answers.json", data: "{}" }], /USAGE\.md/],
    ["size lie", [USAGE, { name: "big.txt", data: "x".repeat(500), declaredSize: 5 }], /larger/],
    ["too large", [USAGE, { name: "big.txt", data: "x".repeat(20_000) }], /unpacked size/],
    [
      "too many files",
      [USAGE, ...Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, data: "x" }))],
      /entries/,
    ],
  ] as const)
    await assert.rejects(unpack(zip([...entries])), pattern, label);
  const nested = await unpack(deliverable(PERFECT, "pkg/"));
  assert.equal(nested.content_root, path.join(root, `case-${n}`, "pkg"));
  assert.equal(nested.files, 2);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(nested.content_root, "answers.json"), "utf8")),
    PERFECT,
  );

  // --- dispatch ---
  const bench = path.join(root, "bench");
  const fakePaseo = path.join(root, "fake-paseo.mjs");
  fs.writeFileSync(
    fakePaseo,
    "console.log(JSON.stringify({ agentId: process.env.PASEO_AGENT_ID ?? 'standalone', argv: process.argv.slice(2) }));",
  );
  const agent = {
    provider: "codex" as const,
    thinking: "max" as const,
    model: "gpt-5.6-terra",
    paseo_command: [process.execPath, fakePaseo],
  };
  const request = { root, submission_id: "s001", submission_dir: path.join(root, "s001") };
  const argv = paseoRunArgv(agent, reviewRun(request));
  for (const flag of ["run", "-d", "--json", "--model", "aris.role=validator", "aris.submission=s001"])
    assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf("--provider"), argv.indexOf("--provider") + 4), [
    "--provider",
    "codex",
    "--thinking",
    "max",
  ]);
  const leakArgv = paseoRunArgv(
    agent,
    leakReviewRun({ ...request, review_dir: path.join(root, "s001", "leak-review", "1") }),
  );
  assert.ok(leakArgv.includes("aris.role=leak-review"));
  assert.match(leakArgv.at(-1)!, /leak-review\.md/);
  process.env.PASEO_AGENT_ID = "parent-agent";
  assert.deepEqual(await paseoDispatcher(agent)(request), { agent_id: "standalone" });
  delete process.env.PASEO_AGENT_ID;

  // --- service ---
  await setupTesterFacility(root, facilityConfig(root));
  const config: ValidationConfig = {
    schema_version: 2,
    pass_rule: { metric: "score", op: ">=", threshold: 1 },
    tester_config_sha256: testerFacilityConfigSha256(
      readTesterFacilityConfig(testerConfigPath(root)),
    ),
    adapter_contract: "The runner reads answers.json from the deliverable.",
    limits: {
      max_submissions: 4,
      max_concurrent: 1,
      max_upload_bytes: 100_000,
      max_unpacked_bytes: 100_000,
      max_files: 50,
      upload_ttl_minutes: 60,
      review_timeout_minutes: 60,
      feedback_attempts: 1,
      max_new_tests_per_review: 3,
    },
    hidden_paths: [bench],
    agent: { provider: "codex", thinking: "max", paseo_command: ["paseo"] },
    service: { host: "127.0.0.1", public_url: "https://validation.example" },
  };
  writeStateJsonAtomic(validationConfigPath(root), config);
  const token = ensureValidationToken(root);
  const dispatched: string[] = [];
  let failDispatch = false;
  const service = await startValidationService(root, {
    port: 0,
    tick_ms: 3_600_000,
    log: () => {},
    dispatcher: async ({ submission_id }) => {
      if (failDispatch) throw new Error("paseo is down");
      dispatched.push(submission_id);
      return { agent_id: `agent-${submission_id}` };
    },
  });
  const leakRuns: string[] = [];
  const leakStarter = async (run: { title: string }) => {
    leakRuns.push(run.title);
    return { agent_id: `leak-${leakRuns.length}` };
  };
  try {
    let rpcId = 0;
    const post = (body: unknown, auth = true) =>
      fetch(`${service.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    const rpc = async (method: string, params: unknown = {}) =>
      (await (await post({ jsonrpc: "2.0", id: ++rpcId, method, params })).json()) as any;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const { result } = await rpc("tools/call", { name, arguments: args });
      return { error: result.isError === true, text: result.content[0].text as string };
    };
    const submit = async () => JSON.parse((await call("submit")).text);
    const upload = (url: string, body: Buffer) =>
      fetch(url.replace(config.service.public_url, service.url), { method: "PUT", body });
    const status = (id: string) => readSubmission(root, id).status;
    const write = (id: string, file: string, text: string) => {
      const target = path.join(submissionDir(root, id), file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    /** Stands in for the independent leak reviewer of the latest request. */
    const leakVerdict = (id: string, verdict: "pass" | "leak", findings: string[] = []) => {
      const review = readSubmission(root, id).leak_reviews!.at(-1)!;
      fs.writeFileSync(path.join(review.dir, "result.json"), JSON.stringify({ verdict, findings }));
    };

    assert.equal((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, false)).status, 401);
    assert.equal((await fetch(`${service.url}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "aris-validation");
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = await rpc("tools/list");
    assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name), ["submit", "query"]);

    // A malformed deliverable is refused and does not count.
    const s1 = await submit();
    assert.equal(s1.submission_id, "s001");
    assert.match(s1.upload_command, /^curl\.exe --fail-with-body -T deliverable\.zip "https:\/\/validation\.example\/upload\/s001\//);
    const bad = await upload(s1.upload_url, zip([USAGE, { name: "../evil", data: "x" }]));
    assert.equal(bad.status, 422);
    assert.equal(status("s001"), "invalid");
    assert.equal(serviceSummary(root, config).counted, 0);
    assert.equal((await upload(s1.upload_url, deliverable(PERFECT))).status, 404);

    // A valid deliverable is queued, then one validator agent is started for it.
    const s2 = await submit();
    assert.equal((await upload(s2.upload_url, deliverable({ "sample-alpha": "the quick brown fox" }))).status, 200);
    await service.tick();
    assert.equal(status("s002"), "reviewing");
    assert.deepEqual(dispatched, ["s002"]);
    assert.equal(readSubmission(root, "s002").agent_id, "agent-s002");
    assert.equal((await upload(s2.upload_url, deliverable(PERFECT))).status, 404);

    // The validator agent's side: smoke, then every layer; one sample is one test.
    assert.equal((await runSmoke(root, "s002")).sample_count, 1);
    write("s002", "review.json", JSON.stringify({ verdict: "valid", reasons: ["ran as documented"] }));
    assert.throws(() => finalizeSubmission(root, "s002"), /EVALUATION_REQUIRED/);
    const base = await evaluate(root, "s002");
    assert.deepEqual(base.runs.map((run) => [run.layer, run.tests]), [["base", { total: 2, passed: 1, failed: 1 }]]);

    // New tests derive from tests this review has run and are drafted inside the submission directory.
    const layerRunner = [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const labels = JSON.parse(fs.readFileSync(new URL("./labels.json", import.meta.url), "utf8"));',
      "let answers = {};",
      'try { answers = JSON.parse(fs.readFileSync(path.join(process.env.ARIS_ARTIFACT_REF, "answers.json"), "utf8")); } catch {}',
      'const samples = Object.keys(labels).map((id) => ({ id, status: "ok", metrics: { score: answers[id] === labels[id] ? 1 : 0 } }));',
      "fs.writeFileSync(process.env.ARIS_TEST_OUTPUT, JSON.stringify({ artifact_sha256: process.env.ARIS_ARTIFACT_SHA256, samples }));",
      // A runner may write into its own copy of the layer; the registered layer is untouched.
      'fs.writeFileSync("cache.json", "{}");',
    ].join("\n");
    const draftLayer = (dir: string, tests: { id: string; derived_from: string[] }[]) => {
      write("s002", `${dir}/runner.mjs`, layerRunner);
      write("s002", `${dir}/labels.json`, JSON.stringify(Object.fromEntries(tests.map((test) => [test.id, "jumps over"]))));
      write("s002", `${dir}/layer.json`, JSON.stringify({
        problem: "multi-word answers cut short",
        method: "rephrased variants of a failed question",
        run: { argv: [process.execPath, "runner.mjs"], timeout_ms: 10_000 },
        tests: tests.map((test) => ({ ...test, variation: "same question, reordered", reference_check: "label carried over from the parent" })),
      }));
      return path.join(submissionDir(root, "s002"), dir);
    };
    const variant = (id: string, from = "base:sample-bravo") => ({ id, derived_from: [from] });
    assert.throws(() => extendBenchmark(root, "s002", draftLayer("draft-x", [variant("v1", "base:invented")])), /TEST_NOT_DERIVED/);
    assert.throws(() => extendBenchmark(root, "s002", draftLayer("draft-y", ["v1", "v2", "v3", "v4"].map((id) => variant(id)))), /TEST_LIMIT/);
    const outside = path.join(root, "outside-draft");
    fs.cpSync(draftLayer("draft-z", [variant("v1")]), outside, { recursive: true });
    assert.throws(() => extendBenchmark(root, "s002", outside), /INVALID_LAYER/);
    const extended = extendBenchmark(root, "s002", draftLayer("draft-a", [variant("v1"), variant("v2")]));
    assert.equal(extended.layer.id, "inc-001");
    assert.equal(extended.layer.tests, 2);
    assert.throws(() => finalizeSubmission(root, "s002"), /EVALUATION_REQUIRED: .*inc-001/);
    const inc = await evaluate(root, "s002", "inc-001");
    assert.deepEqual(inc.runs[0]!.tests, { total: 2, passed: 0, failed: 2 });
    // Tests of the new layer can be parents too, but the per-review limit still holds.
    assert.throws(
      () => extendBenchmark(root, "s002", draftLayer("draft-b", [variant("w1", "inc-001:v1"), variant("w2", "inc-001:v2")])),
      /TEST_LIMIT/,
    );

    // Feedback goes out only after an independent leak review of exactly this text.
    write("s002", "feedback.md", "Answers keep only the first words of a longer expected answer.");
    assert.throws(() => finalizeSubmission(root, "s002"), /LEAK_REVIEW_REQUIRED/);
    await requestLeakReview(root, "s002", leakStarter);
    assert.deepEqual(leakRuns, ["ARIS leak review s002"]);
    assert.throws(() => finalizeSubmission(root, "s002"), /LEAK_REVIEW_PENDING/);
    leakVerdict("s002", "leak", ["names the failing question's expected answer"]);
    assert.throws(() => finalizeSubmission(root, "s002"), /FEEDBACK_LEAKS_HIDDEN_DATA.*1 attempts left/);
    write("s002", "feedback.md", "Multi-word answers are cut short.");
    assert.throws(() => finalizeSubmission(root, "s002"), /LEAK_REVIEW_REQUIRED/);
    await requestLeakReview(root, "s002", leakStarter);
    leakVerdict("s002", "leak", ["still describes one specific test"]);
    // The single permitted rewrite still leaked: the result goes out without feedback.
    await assert.rejects(requestLeakReview(root, "s002", leakStarter), /LEAK_REVIEWS_EXHAUSTED/);
    const published = finalizeSubmission(root, "s002");
    assert.deepEqual(published.tests, { total: 4, passed: 1, failed: 3 });
    assert.equal(published.feedback_withheld, true);
    const q2 = await call("query", { submission_id: "s002" });
    const view = JSON.parse(q2.text);
    assert.equal(view.submission.verdict, "valid");
    assert.deepEqual(view.submission.tests, { total: 4, passed: 1, failed: 3 });
    assert.equal(view.submission.feedback, "");
    assert.equal(view.service.state, "open");
    assert.equal(view.service.best, undefined);
    for (const hidden of ["sample-alpha", "inc-001", "derived_from"])
      assert.ok(!q2.text.includes(hidden), `query never exposes ${hidden}`);

    // A cheating verdict voids every test; feedback that passed the leak review is published.
    const s3 = await submit();
    await upload(s3.upload_url, deliverable(PERFECT));
    await service.tick();
    write("s003", "review.json", JSON.stringify({ verdict: "cheating", reasons: ["answers are hard-coded"] }));
    write("s003", "feedback.md", "The deliverable returns stored answers instead of computing them.");
    await requestLeakReview(root, "s003", leakStarter);
    leakVerdict("s003", "pass");
    const cheated = finalizeSubmission(root, "s003");
    assert.equal(cheated.status, "rejected_cheating");
    assert.equal(cheated.tests, null);
    assert.match(JSON.parse((await call("query", { submission_id: "s003" })).text).submission.feedback, /stored answers/);

    // Live reservations hold slots; the limit refuses more until one expires.
    const s4 = await submit();
    await submit(); // s005
    const refused = await call("submit");
    assert.equal(refused.error, true);
    assert.match(refused.text, /SUBMISSION_LIMIT/);
    withSubmissionsLock(root, () =>
      updateSubmission(root, "s005", { upload: { ...readSubmission(root, "s005").upload!, expires_at: new Date(0).toISOString() } }),
    );
    await service.tick();
    assert.equal(status("s005"), "expired");

    // Our own failure to start an agent does not cost the worker a submission.
    const s6 = await submit();
    failDispatch = true;
    await upload(s6.upload_url, deliverable(PERFECT));
    await service.tick();
    failDispatch = false;
    assert.equal(status("s006"), "failed");
    assert.equal(serviceSummary(root, config).counted, 2);
    const s7 = await submit();

    // A registered layer never changes: editing one stops validation until it is restored.
    const repo = benchmarkRepo(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    assert.deepEqual(git("log", "--format=%s").split(/\r?\n/), ["extend inc-001 (s002)", "benchmark: empty root"]);
    assert.equal(fs.existsSync(path.join(layerDir(root, "inc-001"), "cache.json")), false);
    const layerLabels = path.join(layerDir(root, "inc-001"), "labels.json");
    const original = fs.readFileSync(layerLabels);
    fs.appendFileSync(layerLabels, " ");
    assert.match((await call("submit")).text, /BENCHMARK_CHANGED: registered benchmark files were edited/);
    // Committing the edit is caught commit by commit, even with the head record moved along.
    const head = git("rev-parse", "HEAD");
    const headRecord = path.join(root, ".aris", "validation", "benchmark-head");
    git("commit", "-q", "--no-verify", "-am", "edit a test");
    assert.match((await call("submit")).text, /history was rewritten/);
    fs.writeFileSync(headRecord, git("rev-parse", "HEAD"));
    assert.match((await call("submit")).text, /modifies or deletes files/);
    git("reset", "-q", "--hard", head);
    fs.writeFileSync(headRecord, head);
    // Dropping a layer by resetting the history no longer matches the recorded head.
    git("reset", "-q", "--hard", "HEAD~1");
    assert.match((await call("submit")).text, /history was rewritten/);
    git("reset", "-q", "--hard", head);
    assert.equal(fs.readFileSync(layerLabels, "utf8"), original.toString());

    // Passing every test does not end validation; only the submission limit does.
    await upload(s4.upload_url, deliverable(PERFECT));
    await upload(s7.upload_url, deliverable(PERFECT));
    await service.tick();
    assert.equal(status("s004"), "reviewing");
    assert.equal(status("s007"), "queued");
    // A wrong layer is retired, not edited; its tests stop counting.
    assert.equal(retireBenchmarkLayer(root, "s004", "inc-001", "reference answers were wrong").retired?.by, "s004");
    await evaluate(root, "s004");
    write("s004", "review.json", JSON.stringify({ verdict: "valid", reasons: ["clean"] }));
    assert.deepEqual(finalizeSubmission(root, "s004").tests, { total: 2, passed: 2, failed: 0 });
    assert.equal(serviceSummary(root, config).state, "open");
    await service.tick();
    assert.equal(status("s007"), "reviewing");
    write("s007", "review.json", JSON.stringify({ verdict: "unusable", reasons: ["install fails"] }));
    assert.equal(finalizeSubmission(root, "s007").tests, null);
    const done = JSON.parse((await call("query")).text);
    assert.equal(done.service.state, "closed");
    assert.equal(done.service.remaining, 0);
    assert.match((await call("submit")).text, /SUBMISSION_LIMIT/);
    // A benchmark changed while the service runs refuses new submissions.
    const labels = fs.readFileSync(path.join(bench, "labels.json"));
    fs.appendFileSync(path.join(bench, "labels.json"), " ");
    assert.match((await call("submit")).text, /BENCHMARK_CHANGED|TESTER_EVIDENCE_CHANGED/);
    fs.writeFileSync(path.join(bench, "labels.json"), labels);
  } finally {
    await service.close();
  }

  // A changed benchmark stops the service.
  fs.appendFileSync(path.join(bench, "labels.json"), " ");
  await assert.rejects(startValidationService(root, { port: 0 }), /BENCHMARK_CHANGED|TESTER_EVIDENCE_CHANGED/);
  console.log("validation: unzip, dispatch, layers, leak review, service and stop rules passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  applySetup,
  confirmSetupReview,
  refreshSetupReview,
  SetupReviewIncompleteError,
} from "../src/tools/setup.js";
import { readValidationConfig, validationTokenPath } from "../src/tools/validation/config.js";
import { createSubmission, updateSubmission, withSubmissionsLock } from "../src/tools/validation/store.js";
import { facilityConfig } from "./helpers/tester-facility-fixture.js";
import { environmentSkillDir, projectSlug } from "../src/tools/setup.js";

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
// A command execFile can start on every platform; only its argv is checked here.
const PASEO = [process.execPath, "paseo-cli.mjs"];
const installAs = (root: string, role: "worker" | "validator") => {
  fs.mkdirSync(path.join(root, ".aris"), { recursive: true });
  const provider = role === "worker" ? "claude" : "codex";
  fs.writeFileSync(path.join(root, ".aris/install.json"), JSON.stringify({ role, provider }));
};
const issueFields = (root: string) => refreshSetupReview(root).issues.map((issue) => issue.field);
async function project(name: string, action: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aris-setup-${name}-`));
  try {
    await action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Worker: the installed role decides the modules; task.md is part of what the owner approves.
await project("worker", async (root) => {
  assert.throws(() => refreshSetupReview(root), /--role worker\|validator/);
  installAs(root, "worker");
  let review = refreshSetupReview(root);
  assert.equal(review.role, "worker");
  assert.deepEqual(
    review.modules.map((module) => module.id),
    ["project", "environment", "connection"],
  );
  assert.ok(issueFields(root).includes("task.md"));
  assert.ok(issueFields(root).includes("connection.url"));

  fs.writeFileSync(path.join(root, "task.md"), "# Task\nAnswer the questions.\n");
  // The environment configuration holds only keys and tokens; null clears one.
  review = refreshSetupReview(root, {
    connection: { url: "http://validation.example:7000/proxy/abc/mcp", token: "t".repeat(43) },
    environment: { secrets: { HF_TOKEN: "hf_secret", "not a name": "x" } },
  });
  const sheet = fs.readFileSync(review.review_path, "utf8");
  assert.equal(sheet.includes("hf_secret") || sheet.includes("t".repeat(43)), false);
  assert.ok(review.modules.flatMap((module) => module.fields).some((field) => field.value === "…cret"));
  assert.deepEqual(
    review.issues.map((issue) => issue.field),
    ["environment.secrets.not a name"],
  );
  review = refreshSetupReview(root, { environment: { secrets: { "not a name": null } } });
  assert.deepEqual(review.issues, []);
  assert.equal(review.ready_to_confirm, true);
  await assert.rejects(applySetup(root), /SETUP_CONFIGURATION_CONFIRMATION_REQUIRED|confirm/);

  // Editing task.md after review invalidates the reviewed digest.
  const reviewed = review.configuration_sha256;
  fs.appendFileSync(path.join(root, "task.md"), "Use English.\n");
  assert.throws(() => confirmSetupReview(root, reviewed), /refresh and confirm/);
  review = refreshSetupReview(root);
  assert.notEqual(review.configuration_sha256, reviewed);
  confirmSetupReview(root, review.configuration_sha256);
  assert.equal(refreshSetupReview(root).confirmed, true);

  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x" } } }),
  );
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Owner notes\n");
  const applied = await applySetup(root);
  assert.equal(applied.role, "worker");
  assert.deepEqual(applied.agent, { provider: "claude", thinking: "ultracode" });
  assert.equal(applied.environment_skill_dir, environmentSkillDir(root));
  assert.match(applied.environment_skill_dir, /\.claude[/\\]skills[/\\].+-environment$/);
  // Apply names the environment skill; setup's agent writes it.
  assert.equal(fs.existsSync(applied.environment_skill_dir), false);
  assert.deepEqual(read(applied.environment_secrets), { HF_TOKEN: "hf_secret" });
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".aris/\n.mcp.json\n");
  const mcp = read(path.join(root, ".mcp.json"));
  assert.deepEqual(mcp.mcpServers.other, { command: "x" });
  assert.deepEqual(mcp.mcpServers["aris-validation"], {
    type: "http",
    url: "http://validation.example:7000/proxy/abc/mcp",
    headers: { Authorization: `Bearer ${"t".repeat(43)}` },
  });
  // The role block is added once and replaced in place on re-apply.
  await applySetup(root);
  const claude = fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8");
  assert.ok(claude.startsWith("# Owner notes\n"));
  assert.equal(claude.split("<!-- ARIS ROLE BEGIN -->").length, 2);
  assert.match(claude, /ARIS role: worker/);
  assert.ok(claude.includes(`.claude/skills/${projectSlug(root)}-environment/SKILL.md`));
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false);
});

assert.match(projectSlug(path.join(os.tmpdir(), "项目")), /^project-[0-9a-f]{8}$/);

// Validator: Codex at max, the benchmark is installed, the terms frozen, and the service registered.
await project("validator", async (root) => {
  installAs(root, "validator");
  fs.writeFileSync(path.join(root, "task.md"), "# Task\nAnswer the questions.\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Owner instructions.\n");
  const benchmark = facilityConfig(root);
  let review = refreshSetupReview(root, {
    validation: { benchmark, pass_rule: { metric: "missing", threshold: 1 } },
  });
  assert.equal(review.role, "validator");
  assert.ok(review.issues.some((issue) => issue.field === "validation"));
  review = refreshSetupReview(root, {
    validation: {
      pass_rule: { metric: "score", op: ">=", threshold: 1 },
      hidden_paths: [path.join(root, "bench", "labels.json")],
      agent: { provider: "claude", paseo_command: ["paseo"] },
      service: { host: "0.0.0.0", port: 70_000, public_url: "https://validation.example/" },
    },
  });
  assert.deepEqual(
    review.issues.map((issue) => issue.field),
    [
      ...(process.platform === "win32" ? ["validation.agent.paseo_command"] : []),
      "validation.service.port",
      "validation",
    ],
  );
  assert.match(review.issues.at(-1)!.message, /codex/);
  review = refreshSetupReview(root, {
    validation: { agent: { provider: null, paseo_command: PASEO }, service: { port: 8765 } },
  });
  assert.deepEqual(review.issues, []);
  assert.throws(
    () => confirmSetupReview(root, "0".repeat(64)),
    /refresh and confirm/,
  );
  confirmSetupReview(root, review.configuration_sha256);
  const applied = await applySetup(root);
  assert.equal(applied.role, "validator");
  if (applied.role !== "validator") throw new Error("unreachable");
  assert.deepEqual(applied.agent, { provider: "codex", thinking: "max" });
  assert.match(applied.environment_skill_dir, /\.agents[/\\]skills[/\\].+-environment$/);
  assert.equal(applied.worker_connection.url, "https://validation.example/mcp");
  assert.equal(
    applied.worker_connection.token,
    fs.readFileSync(validationTokenPath(root), "utf8").trim(),
  );
  const config = readValidationConfig(root);
  assert.deepEqual(config.pass_rule, { metric: "score", op: ">=", threshold: 1 });
  assert.deepEqual(config.agent, { provider: "codex", thinking: "max", mode: "full-access", paseo_command: PASEO });
  assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".aris/\n");
  assert.equal(config.limits.max_submissions, 20);
  assert.ok(fs.existsSync(path.join(root, ".aris", "tester-config.json")));
  // The fixed port lives only in the Paseo service entry; the frozen config keeps the bind host.
  assert.deepEqual(read(path.join(root, "paseo.json")).scripts["aris-validation"], {
    type: "service",
    command: "node .aris/dist/tools/validation-cli.js serve --project .",
    port: 8765,
  });
  assert.deepEqual(config.service, { host: "0.0.0.0", public_url: "https://validation.example" });
  const instructions = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  assert.ok(instructions.startsWith("Owner instructions.\n"));
  assert.match(instructions, /ARIS role: validator/);
  assert.ok(instructions.includes(`.agents/skills/${projectSlug(root)}-environment/SKILL.md`));
  assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);

  // Re-applying keeps the token the worker already holds.
  const again = await applySetup(root);
  if (again.role !== "validator") throw new Error("unreachable");
  assert.equal(again.worker_connection.token, applied.worker_connection.token);

  // Missing hidden data is reported.
  review = refreshSetupReview(root, {
    validation: { hidden_paths: [path.join(root, "nowhere")] },
  });
  assert.ok(review.issues.some((issue) => issue.field === "validation.hidden_paths"));
  review = refreshSetupReview(root, {
    validation: { hidden_paths: [path.join(root, "bench", "labels.json")] },
  });
  assert.deepEqual(review.issues, []);

  // Once a submission counts, the base benchmark and pass rule are frozen; limits may still change.
  const { record } = createSubmission(root, config, undefined);
  withSubmissionsLock(root, () => updateSubmission(root, record.submission_id, { status: "queued" }));
  review = refreshSetupReview(root, { validation: { pass_rule: { threshold: 0.5 } } });
  assert.ok(review.issues.some((issue) => issue.message.includes("frozen")));
  review = refreshSetupReview(root, {
    validation: { pass_rule: { threshold: 1 }, limits: { max_submissions: 30 } },
  });
  assert.deepEqual(review.issues, []);
  confirmSetupReview(root, review.configuration_sha256);
  const receiptFile = path.join(root, ".aris/tester-config.json.setup.json");
  const receipt = fs.readFileSync(receiptFile, "utf8");
  await applySetup(root);
  assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
  fs.appendFileSync(path.join(root, "bench/runner.mjs"), "\n// changed benchmark\n");
  await assert.rejects(applySetup(root), /changed|mismatch/i);
  assert.equal(fs.readFileSync(receiptFile, "utf8"), receipt);
  try {
    confirmSetupReview(root, refreshSetupReview(root, { project: { name: "" } }).configuration_sha256);
    assert.fail("an incomplete sheet must not confirm");
  } catch (error) {
    assert.ok(error instanceof SetupReviewIncompleteError);
  }
});

// Build a real archive, then exercise only extracted and installed files in unrelated directories.
await project("distribution", async (sandbox) => {
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const archive = execFileSync(process.execPath, [path.join(source, "tools/pack-arl.mjs"), sandbox], { encoding: "utf8" }).trim();
  execFileSync("tar", ["-xzf", archive, "-C", sandbox]);
  const extracted = path.join(sandbox, "arl");
  const portable = path.join(sandbox, "moved archive");
  fs.renameSync(extracted, portable);
  const archiveManifest = read(path.join(portable, "manifest.json"));
  assert.equal(fs.existsSync(path.join(portable, "LICENSE")), true);
  assert.equal(archiveManifest.files.some((file: { path: string }) => file.path.startsWith("src/") || file.path.startsWith("agents/") || file.path.includes("server/src/")), false);
  assert.equal(fs.existsSync(path.join(portable, "skills/arxiv")), false);
  assert.equal(fs.existsSync(path.join(portable, "dist/tools/arxiv-fetch.js")), false);
  for (const role of ["worker", "validator"] as const) {
    const provider = role === "worker" ? "claude" : "codex";
    const root = path.join(sandbox, `${role} project`);
    const skillDir = role === "worker" ? ".claude/skills" : ".agents/skills";
    const install = (...extra: string[]) => execFileSync("bash", [path.join(portable, "install.sh"), "--role", role, "--project", root, ...extra], { cwd: sandbox, encoding: "utf8" });
    install("--dry-run");
    assert.equal(fs.existsSync(root), false);
    install();
    const manifest = read(path.join(root, ".aris/install.json"));
    assert.equal(manifest.role, role);
    assert.equal(manifest.provider, provider);
    assert.deepEqual(fs.readdirSync(path.join(root, skillDir)).sort(), ["aris-setup", "browser-act", "research-wiki", "shared-references", "validation-review"]);
    assert.equal(fs.existsSync(path.join(root, ".claude/agents")), false);
    const setup = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [path.join(root, ".aris/dist/tools/setup-cli.js"), ...args, "--project", root], { cwd: sandbox, encoding: "utf8" }));
    fs.writeFileSync(path.join(root, "task.md"), "An isolated installed task.\n");
    const patch = path.join(root, "patch.json");
    if (role === "worker") {
      fs.writeFileSync(patch, JSON.stringify({ environment: { secrets: { API_KEY: "k" } }, connection: { url: "https://validation.example/mcp", token: "k".repeat(43) } }));
    } else {
      const benchmark = facilityConfig(root);
      fs.writeFileSync(patch, JSON.stringify({ validation: { benchmark, pass_rule: { metric: "score", op: ">=", threshold: 1 }, hidden_paths: [path.join(root, "bench/labels.json")], agent: { paseo_command: PASEO }, service: { public_url: "http://validation.example:8790", port: 8790 } } }));
    }
    const review = setup("review", "--input", patch);
    assert.deepEqual(review.issues, []);
    setup("confirm", "--digest", review.configuration_sha256);
    const applied = setup("apply");
    assert.equal(applied.role, role);
    assert.equal(applied.environment_skill_dir, path.join(root, skillDir, `${projectSlug(root)}-environment`));
    // Apply declares the expected skill output; it does not pretend agent generation has run.
    assert.equal(fs.existsSync(applied.environment_skill_dir), false);
    const instructions = fs.readFileSync(path.join(root, role === "worker" ? "CLAUDE.md" : "AGENTS.md"), "utf8");
    assert.equal(instructions.includes("{{PROJECT_SLUG}}"), false);
    assert.ok(instructions.includes(`${skillDir}/${projectSlug(root)}-environment/SKILL.md`));
    if (role === "worker") {
      assert.deepEqual(read(path.join(root, ".aris/environment.json")), { API_KEY: "k" });
      const toolLinks = [...instructions.matchAll(/\]\(([^)]+\/SKILL\.md)\)/g)].map((match) => match[1]!);
      for (const skill of ["research-wiki", "browser-act", "aris-setup"]) {
        assert.ok(toolLinks.includes(`${skillDir}/${skill}/SKILL.md`), `Worker role does not route to ${skill}`);
      }
      for (const link of toolLinks.filter((link) => !link.includes("-environment/")))
        assert.equal(fs.existsSync(path.join(root, link)), true, `Installed worker tool is missing: ${link}`);
    } else {
      assert.deepEqual(read(path.join(root, ".aris/validation/config.json")).agent, { provider: "codex", thinking: "max", mode: "full-access", paseo_command: PASEO });
      const status = JSON.parse(execFileSync(process.execPath, [path.join(root, ".aris/dist/tools/validation-cli.js"), "status", "--project", root], { cwd: sandbox, encoding: "utf8" }));
      assert.equal(status.service.state, "open");
    }
    const state = fs.readFileSync(path.join(root, ".aris/setup-state.json"), "utf8");
    execFileSync(process.execPath, [path.join(root, ".aris/dist/tools/research-wiki.js"), "init", path.join(root, "research-wiki")], { cwd: sandbox });
    const wiki = fs.readFileSync(path.join(root, "research-wiki/index.md"), "utf8");
    const generated = path.join(root, skillDir, `${projectSlug(root)}-environment/SKILL.md`);
    fs.mkdirSync(path.dirname(generated), { recursive: true });
    fs.writeFileSync(generated, "owner generated\n");
    // Upgrading a previous archive removes the retired skill only when ARL owns it.
    const retired = path.join(root, skillDir, "aris-update/SKILL.md");
    fs.mkdirSync(path.dirname(retired), { recursive: true });
    fs.writeFileSync(retired, "old managed update skill\n");
    manifest.files[`${skillDir}/aris-update/SKILL.md`] = crypto.createHash("sha256").update(fs.readFileSync(retired)).digest("hex");
    fs.writeFileSync(path.join(root, ".aris/install.json"), JSON.stringify(manifest));
    const helper = path.join(root, ".aris/dist/tools/setup-cli.js");
    fs.unlinkSync(helper);
    install();
    assert.equal(fs.existsSync(helper), true);
    assert.equal(fs.existsSync(retired), false);
    assert.equal(fs.readFileSync(path.join(root, ".aris/setup-state.json"), "utf8"), state);
    assert.equal(fs.readFileSync(path.join(root, "research-wiki/index.md"), "utf8"), wiki);
    assert.equal(fs.readFileSync(generated, "utf8"), "owner generated\n");
    const skill = path.join(root, skillDir, "aris-setup/SKILL.md");
    fs.appendFileSync(skill, "\nowner edit\n");
    const before = fs.readFileSync(path.join(root, ".aris/install.json"), "utf8");
    assert.throws(() => install(), /Local file differs/);
    assert.equal(fs.readFileSync(path.join(root, ".aris/install.json"), "utf8"), before);
    install("--force");
    assert.equal(fs.readFileSync(skill, "utf8").includes("owner edit"), false);
    const switched = spawnSync("bash", [path.join(portable, "install.sh"), "--role", role === "worker" ? "validator" : "worker", "--project", root], { encoding: "utf8" });
    assert.equal(switched.status, 1);
    assert.match(switched.stderr, /keep its role/);
  }
  // Installation from a prepared local Git checkout needs no download or archive tools.
  const localRepo = path.join(sandbox, "local ARL checkout");
  fs.mkdirSync(localRepo);
  execFileSync("git", ["init", "--quiet", localRepo]);
  for (const directory of ["dist", "skills", "templates"])
    fs.cpSync(path.join(portable, directory), path.join(localRepo, directory), { recursive: true });
  for (const directory of ["distribution", "tools"])
    fs.cpSync(path.join(source, directory), path.join(localRepo, directory), { recursive: true, filter: (file) => path.basename(file) !== "releases" });
  fs.copyFileSync(path.join(source, "package.json"), path.join(localRepo, "package.json"));
  for (const file of ["LICENSE", "SETUP_GUIDE.md", "SETUP_GUIDE_CN.md"])
    fs.copyFileSync(path.join(source, file), path.join(localRepo, file));
  const forbiddenBin = path.join(sandbox, "forbidden commands");
  fs.mkdirSync(forbiddenBin);
  const invoked = path.join(forbiddenBin, "invoked");
  for (const command of ["curl", "wget", "npm", "npx", "tar"])
    fs.writeFileSync(path.join(forbiddenBin, command), '#!/usr/bin/env bash\nprintf "%s\\n" "$0" > "${BASH_SOURCE[0]%/*}/invoked"\nexit 99\n', { mode: 0o755 });
  const localEnv = {
    ...process.env,
    PATH: `${forbiddenBin}${path.delimiter}${process.env.PATH}`,
    ARL_DOWNLOAD_BASE: "http://127.0.0.1:1/must-not-download",
    ARL_ARCHIVE: path.join(sandbox, "does-not-exist.tar.gz"),
  };
  const localInstall = (entry: string, ...args: string[]) => spawnSync("bash", [path.join(localRepo, "distribution", entry), ...args], { cwd: sandbox, env: localEnv, encoding: "utf8" });
  assert.equal(localInstall("install-aris.sh", "--help").status, 0);
  const bootstrapped = path.join(sandbox, "bootstrap project");
  const missing = localInstall("install-aris.sh", "--role", "validator", "--project", bootstrapped);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /npm ci and npm run build/);
  assert.equal(fs.existsSync(bootstrapped), false);
  for (const dependency of ["commander", "typescript"])
    fs.cpSync(path.join(source, "node_modules", dependency), path.join(localRepo, "node_modules", dependency), { recursive: true });
  fs.renameSync(path.join(localRepo, "dist"), path.join(localRepo, "unbuilt-dist"));
  const unbuilt = localInstall("install-aris.sh", "--role", "validator", "--project", bootstrapped);
  assert.equal(unbuilt.status, 1);
  assert.match(unbuilt.stderr, /npm ci and npm run build/);
  assert.equal(fs.existsSync(bootstrapped), false);
  fs.renameSync(path.join(localRepo, "unbuilt-dist"), path.join(localRepo, "dist"));
  for (const role of ["worker", "validator"]) {
    const root = role === "validator" ? bootstrapped : path.join(sandbox, "local worker project");
    const preview = localInstall("install-aris.sh", "--role", role, "--project", root, "--dry-run");
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(fs.existsSync(root), false);
    const installed = localInstall("install-aris.sh", "--role", role, "--project", root);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(read(path.join(root, ".aris/install.json")).role, role);
    execFileSync(process.execPath, [path.join(root, ".aris/dist/tools/setup-cli.js"), "--help"], { cwd: sandbox });
  }
  const localSkill = path.join(localRepo, "skills/aris-setup/SKILL.md");
  fs.appendFileSync(localSkill, "\nLocal checkout update.\n");
  const updated = localInstall("install-arl.sh", "--role", "validator", "--project", bootstrapped);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(fs.readFileSync(path.join(bootstrapped, ".agents/skills/aris-setup/SKILL.md"), "utf8"), /Local checkout update/);
  assert.equal(fs.existsSync(invoked), false, "Installer invoked a download, dependency installation or archive command");
  assert.equal(read(path.join(bootstrapped, ".aris/install.json")).provider, "codex");
  const changedSkill = path.join(portable, "skills/aris-setup/SKILL.md");
  fs.appendFileSync(changedSkill, "\nNew upstream instructions.\n");
  archiveManifest.version = "0.1.1";
  const changedEntry = archiveManifest.files.find((file: { path: string }) => file.path === "skills/aris-setup/SKILL.md");
  changedEntry.sha256 = crypto.createHash("sha256").update(fs.readFileSync(changedSkill)).digest("hex");
  fs.writeFileSync(path.join(portable, "manifest.json"), JSON.stringify(archiveManifest));
  execFileSync("bash", [path.join(portable, "install.sh"), "--role", "validator", "--project", bootstrapped], { cwd: sandbox });
  assert.equal(read(path.join(bootstrapped, ".aris/install.json")).version, "0.1.1");
  assert.match(fs.readFileSync(path.join(bootstrapped, ".agents/skills/aris-setup/SKILL.md"), "utf8"), /New upstream instructions/);
  const damaged = path.join(portable, "dist/tools/setup-cli.js");
  fs.appendFileSync(damaged, "\n// changed\n");
  const rejectedRoot = path.join(sandbox, "rejected");
  const rejected = spawnSync("bash", [path.join(portable, "install.sh"), "--role", "worker", "--project", rejectedRoot], { encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Archive integrity check failed/);
  assert.equal(fs.existsSync(rejectedRoot), false);
});

console.log("test_setup: ok");

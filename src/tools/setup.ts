/**
 * The one editable configuration sheet behind `/aris-setup` for the installed worker or validator role.
 * refresh writes the draft and its review, confirm records the owner's approval
 * of one digest, and apply is the only step that changes the project.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonSha256 } from "./canonical-json.js";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "./state-file.js";
import {
  setupTesterFacility,
  testerFacilityConfigSha256,
  validateTesterFacilityConfig,
  type TesterFacilityConfig,
} from "./tester-facility.js";
import { failA1, isRecord, type JsonObject } from "./validate.js";
import {
  DEFAULT_LIMITS,
  PASS_OPERATORS,
  VALIDATOR_MODES,
  readValidationConfig,
  ensureValidationToken,
  validateValidationConfig,
  validationConfigPath,
  type ValidationConfig,
} from "./validation/config.js";
import { assertBenchmarkIntact } from "./validation/layers.js";
import { countedSubmissions } from "./validation/store.js";
import {
  ROLE_AGENT,
  installedProvider,
  installedRole,
  providerSkillsDir,
  type ArlRole,
} from "./provider.js";

export type SetupRole = ArlRole;
export interface SetupDraft {
  schema_version: 1;
  project_root: string;
  configuration: JsonObject;
}
export interface SetupIssue {
  field: string;
  message: string;
}
export interface SetupReviewField {
  path: string;
  value: unknown;
  options?: readonly unknown[];
  recommendation: string;
}
export interface SetupReview {
  role: SetupRole;
  language: "en" | "zh";
  draft_path: string;
  review_path: string;
  task: { path: string; sha256: string | null };
  configuration_sha256: string;
  ready_to_confirm: boolean;
  confirmed: boolean;
  modules: { id: string; title: string; fields: SetupReviewField[] }[];
  issues: SetupIssue[];
}
export class SetupReviewIncompleteError extends Error {
  readonly issues: SetupIssue[];
  constructor(issues: SetupIssue[]) {
    super("SETUP_CONFIGURATION_INCOMPLETE: edit the reported fields, then refresh");
    this.issues = issues;
  }
}

const TITLES: Record<string, string> = {
  project: "项目 / Project",
  environment: "执行环境 / Environment",
  connection: "验证服务连接 / Validation service",
  validation: "验证条款 / Validation terms",
};
const ROLE_MODULES: Record<SetupRole, readonly string[]> = {
  worker: ["project", "environment", "connection"],
  validator: ["project", "environment", "validation"],
};
const MODULE_FIELDS: Record<string, readonly string[]> = {
  project: ["name", "language"],
  environment: ["secrets"],
  connection: ["url", "token"],
  validation: [
    "pass_rule",
    "benchmark",
    "adapter_contract",
    "limits",
    "hidden_paths",
    "agent",
    "service",
  ],
};
const CHOICES: Record<string, readonly unknown[]> = {
  "project.language": ["zh", "en"],
  "validation.agent.mode": VALIDATOR_MODES,
  "validation.pass_rule.op": PASS_OPERATORS,
  "validation.benchmark.metrics.*.direction": ["higher_better", "lower_better"],
  "validation.benchmark.metrics.*.aggregation": ["mean", "sum", "external"],
  "validation.service.host": ["127.0.0.1", "0.0.0.0"],
};
const ADAPTER_CONTRACT =
  'The runner calls `python <ARIS_ADAPTER_DIR>/predict.py <inputs.jsonl> <predictions.jsonl>`. predict.py runs the deliverable in ARIS_ARTIFACT_REF as USAGE.md describes and writes one JSON line {"id", "prediction"} per input. The runner scores the predictions and writes ARIS_TEST_OUTPUT.';
const ROLE_BEGIN = "<!-- ARIS ROLE BEGIN -->";
const ROLE_END = "<!-- ARIS ROLE END -->";
const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates");

function get(object: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        isRecord(value) || Array.isArray(value) ? (value as JsonObject)[part] : undefined,
      object,
    );
}
/** Objects merge, arrays and scalars replace, null clears. */
function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = merge(out[key], value);
  return out;
}
function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (isRecord(value) && !Object.keys(value).length)
  );
}
function readJson(file: string): JsonObject {
  if (!fs.existsSync(file)) return {};
  const value = readStateFile<unknown>(file);
  if (!isRecord(value)) failA1("INVALID_VALUE", `${file} must hold a JSON object`);
  return value;
}

/** A folder name with no ASCII letters or digits (`项目`) still needs a usable skill name. */
export function projectSlug(projectRoot: string): string {
  const name = path.basename(path.resolve(projectRoot));
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return slug || `project-${crypto.createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}
/** Where setup's environment step publishes the project's environment skill. */
export function environmentSkillDir(projectRoot: string): string {
  return path.join(providerSkillsDir(projectRoot), `${projectSlug(projectRoot)}-environment`);
}
/** The only environment configuration file: keys and tokens the environment scripts read. */
export const environmentSecretsPath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "environment.json");
export const setupDraftPath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "setup-draft.json");
const statePath = (root: string): string =>
  path.join(path.resolve(root), ".aris", "setup-state.json");
export const taskPath = (root: string): string => path.join(path.resolve(root), "task.md");

function taskSha256(root: string): string | null {
  const file = taskPath(root);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file);
  return text.toString("utf8").trim()
    ? crypto.createHash("sha256").update(text).digest("hex")
    : null;
}

function moduleDefaults(root: string, module: string): JsonObject {
  if (module === "project") return { name: path.basename(path.resolve(root)), language: "zh" };
  if (module === "environment") return { secrets: {} };
  if (module === "connection") return { url: null, token: null };
  const installed = path.join(root, ".aris", "tester-config.json");
  const benchmark = fs.existsSync(installed)
    ? readJson(installed)
    : readJson(path.join(TEMPLATES, "TESTER_FACILITY_CONFIG_TEMPLATE.json"));
  return {
    pass_rule: { metric: null, op: ">=", threshold: null },
    benchmark,
    adapter_contract: ADAPTER_CONTRACT,
    limits: DEFAULT_LIMITS,
    hidden_paths: [],
    agent: { model: null, mode: "full-access", paseo_command: ["paseo"] },
    service: { host: "127.0.0.1", port: null, public_url: null },
  };
}
/** A draft carries only the modules of the installed role. */
function completeModules(root: string, configuration: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const module of ROLE_MODULES[installedRole(root)])
    out[module] = merge(moduleDefaults(root, module), configuration[module] ?? {});
  return out;
}
function loadDraft(root: string): SetupDraft {
  const file = setupDraftPath(root);
  if (!fs.existsSync(file))
    return { schema_version: 1, project_root: root, configuration: completeModules(root, {}) };
  const draft = readStateFile<SetupDraft>(file);
  if (draft.schema_version !== 1 || draft.project_root !== root || !isRecord(draft.configuration))
    failA1("IDENTITY_MISMATCH", "setup draft must identify this project and schema");
  return draft;
}
/** The task text is part of what the owner approves, so editing task.md needs a new confirmation. */
function draftDigest(root: string, draft: SetupDraft): string {
  return canonicalJsonSha256({ draft: draft as unknown as JsonObject, task: taskSha256(root) });
}

function recommendation(key: string, value: unknown): string {
  const advice: Record<string, string> = {
    "project.language": "zh for Chinese collaboration; en for English.",
    "environment.secrets":
      'Only keys and tokens the environment scripts need, as {"NAME": "value"}; {} when there are none. Hosts, paths and commands go into the environment skill, not here.',
    "connection.url": "The `url` printed by `/aris-setup` on the validator machine.",
    "connection.token":
      "The `token` printed by `/aris-setup`; the provider MCP config will hold it, so keep that file out of git.",
    "validation.pass_rule.metric":
      "The benchmark metric each sample reports; one sample is one test, passed or failed by this rule.",
    "validation.pass_rule.op":
      "How a sample's value compares with the threshold for the test to pass.",
    "validation.pass_rule.threshold":
      "The per-sample value a test must reach, e.g. 1 for an exact-match score of 0 or 1.",
    "validation.adapter_contract":
      "Exactly how your runner calls ARIS_ADAPTER_DIR; a validator agent writes each submission's adapter to this contract.",
    "validation.hidden_paths":
      "Absolute paths of the hidden samples, labels and references; the leak reviewer checks feedback against them.",
    "validation.agent.mode":
      "full-access lets the benchmark and the deliverable's install use the network and paths outside the project; sandboxed modes make those steps fail or wait for approval.",
    "validation.agent.paseo_command":
      'On Windows use ["node", "<install dir>\\\\bin\\\\paseo"]; the paseo.cmd shim cannot be spawned directly.',
    "validation.service.host":
      "127.0.0.1 behind the Paseo service proxy; 0.0.0.0 when the worker connects directly over a private network.",
    "validation.service.port":
      "null lets Paseo pick a port on every start; a direct connection needs a fixed one, e.g. 8765, open in the firewall.",
    "validation.service.public_url":
      "The address the worker machine reaches: the Paseo service proxy URL, or http://<this machine's address>:<port>.",
  };
  if (advice[key]) return advice[key];
  if (key.startsWith("validation.limits."))
    return "Keep the default unless the benchmark or upload size needs otherwise.";
  if (key.startsWith("validation.benchmark."))
    return "Pin the benchmark to exact revisions and Windows-runnable argv; it freezes once a submission is counted.";
  if (Array.isArray(value)) return "Edits replace the whole list; [] clears it.";
  return empty(value) ? "Supply the actual value." : "Keep this value unless it is wrong here.";
}
const isSecret = (key: string): boolean =>
  key === "connection.token" || key.startsWith("environment.secrets.");
/** The review sheet is shown in chat; `mask` keeps keys and tokens out of it. */
function rows(value: unknown, key: string, mask = false): SetupReviewField[] {
  if (isRecord(value) && Object.keys(value).length)
    return Object.entries(value).flatMap(([k, v]) => rows(v, `${key}.${k}`, mask));
  if (Array.isArray(value) && value.some(isRecord))
    return value.flatMap((v, i) => rows(v, `${key}.${i}`, mask));
  if (mask && isSecret(key) && typeof value === "string" && value)
    return [
      { path: key, value: `…${value.slice(-4)}`, recommendation: recommendation(key, value) },
    ];
  const options =
    CHOICES[key.replace(/\.\d+(?=\.|$)/g, ".*")] ??
    (typeof value === "boolean" ? [true, false] : undefined);
  return [
    {
      path: key,
      value: value ?? null,
      ...(options ? { options } : {}),
      recommendation: recommendation(key, value),
    },
  ];
}

/** The validation config this draft would freeze; the benchmark digest is filled in by apply. */
function draftValidationConfig(
  validation: JsonObject,
  benchmark: TesterFacilityConfig,
): ValidationConfig {
  const metricName = get(validation, "pass_rule.metric");
  if (!benchmark.metrics.some((metric) => metric.name === metricName))
    failA1(
      "INVALID_VALUE",
      `choose one of ${JSON.stringify(benchmark.metrics.map((metric) => metric.name))}`,
      "validation.pass_rule.metric",
    );
  const { benchmark: _benchmark, ...rest } = validation;
  // The port belongs to the paseo.json service entry; Paseo hands it to the service as PASEO_PORT.
  const { port: _port, ...service } = isRecord(validation.service) ? validation.service : {};
  return validateValidationConfig({
    ...rest,
    service,
    schema_version: 2,
    tester_config_sha256: testerFacilityConfigSha256(benchmark),
  });
}

export function validateSetupConfiguration(configuration: JsonObject, root: string): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const attempt = (field: string, action: () => void) => {
    try {
      action();
    } catch (error) {
      add(field, (error as Error).message);
    }
  };
  const role = installedRole(root);
  const modules = ROLE_MODULES[role];
  for (const key of Object.keys(configuration))
    if (!modules.includes(key)) add(key, `not a ${role} module`);
  for (const module of modules) {
    const value = configuration[module];
    if (!isRecord(value)) {
      add(module, "module must be an object");
      continue;
    }
    for (const key of Object.keys(value))
      if (!MODULE_FIELDS[module]!.includes(key)) add(`${module}.${key}`, "unknown field");
    for (const row of rows(value, module)) {
      if (row.options && !empty(row.value) && !row.options.includes(row.value))
        add(row.path, `choose one of ${JSON.stringify(row.options)}`);
      if (
        typeof row.value === "string" &&
        /YOUR_|PINNED_COMMIT|PINNED_DATA_REVISION|\/absolute\/path/.test(row.value)
      )
        add(row.path, "replace the template placeholder");
    }
  }
  if (empty(get(configuration, "project.name"))) add("project.name", "required");
  if (!taskSha256(root)) add("task.md", "write the task in task.md at the project root");
  const secrets = get(configuration, "environment.secrets");
  if (!isRecord(secrets)) add("environment.secrets", "must be an object of NAME: value");
  else
    for (const [name, value] of Object.entries(secrets))
      if (
        value !== null &&
        (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || !value)
      )
        add(
          `environment.secrets.${name}`,
          "must be an environment-variable name with a text value",
        );

  if (role === "worker") {
    const url = get(configuration, "connection.url");
    // Validation setup prints `<public_url>/mcp`; a proxy may serve it under a sub-path.
    const parsed = typeof url === "string" && URL.canParse(url) ? new URL(url) : null;
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.pathname.endsWith("/mcp"))
      add("connection.url", "must be the validation service's http(s)://…/mcp URL");
    const token = get(configuration, "connection.token");
    if (typeof token !== "string" || token.length < 32)
      add("connection.token", "paste the token printed by the validation setup");
  }
  if (role === "validator" && isRecord(configuration.validation)) {
    const validation = configuration.validation;
    const command = get(validation, "agent.paseo_command");
    // execFile cannot start the paseo.cmd shim; Windows needs node and the CLI script.
    if (
      process.platform === "win32" &&
      Array.isArray(command) &&
      typeof command[0] === "string" &&
      /(^|[\\/])paseo(\.cmd|\.bat)?$/i.test(command[0])
    )
      add(
        "validation.agent.paseo_command",
        'on Windows use ["node", "<Paseo install>\\\\bin\\\\paseo"]; the paseo shim cannot be started without a shell',
      );
    const port = get(validation, "service.port");
    if (
      port !== null &&
      port !== undefined &&
      !(Number.isInteger(port) && Number(port) > 0 && Number(port) < 65_536)
    )
      add("validation.service.port", "must be null or a TCP port number");
    let benchmark: TesterFacilityConfig | undefined;
    attempt("validation.benchmark", () => {
      benchmark = validateTesterFacilityConfig(validation.benchmark);
    });
    if (benchmark)
      attempt("validation", () => {
        const next = draftValidationConfig(validation, benchmark!);
        for (const hidden of next.hidden_paths)
          if (!fs.existsSync(hidden)) add("validation.hidden_paths", `${hidden} is missing`);
        const frozenFile = validationConfigPath(root);
        if (fs.existsSync(frozenFile) && countedSubmissions(root) > 0) {
          const frozen = validateValidationConfig(readStateFile(frozenFile));
          if (
            frozen.tester_config_sha256 !== next.tester_config_sha256 ||
            canonicalJsonSha256(frozen.pass_rule) !== canonicalJsonSha256(next.pass_rule)
          )
            add(
              "validation",
              "submissions were already tested against the frozen base benchmark and pass rule; start a new validator project to change them",
            );
        }
      });
  }
  return issues;
}

function markdown(review: SetupReview): string {
  const t = (en: string, zh: string) => (review.language === "en" ? en : zh);
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
  const lines = [
    t("# ARIS Configuration Review", "# ARIS 配置总览"),
    "",
    `${t("Role", "角色")}: ${review.role ?? t("unset", "待选择")}`,
    `${t("Configuration version", "配置版本")}: \`${review.configuration_sha256}\``,
    `${t("Editable draft", "可编辑草稿")}: \`${review.draft_path}\``,
    `${t("Task", "任务")}: \`${review.task.path}\` ${review.task.sha256 ? `(sha256 ${review.task.sha256.slice(0, 12)})` : t("(missing)", "（缺失）")}`,
    "",
    t(
      "Edit the draft or describe several changes at once, refresh, then confirm the whole sheet once.",
      "集中修改草稿或一次描述多项修改，刷新后整份确认一次。",
    ),
  ];
  for (const module of review.modules) {
    lines.push(
      "",
      `## ${module.title}`,
      "",
      t(
        "| Field | Current draft | Options | Recommendation |",
        "| 配置项 | 当前草稿 | 可选项 | 建议 |",
      ),
      "| --- | --- | --- | --- |",
    );
    for (const row of module.fields)
      lines.push(
        `| ${row.path} | ${row.value === null ? t("unset", "待填写") : cell(JSON.stringify(row.value))} | ${row.options ? cell(JSON.stringify(row.options)) : t("text/JSON", "文本/JSON")} | ${cell(row.recommendation)} |`,
      );
  }
  lines.push("", t("## Validation", "## 配置检查"), "");
  lines.push(
    ...(review.issues.length
      ? review.issues.map((issue) => `- ${issue.field}: ${issue.message}`)
      : [
          t(
            "- All fields pass; review the sheet, then confirm.",
            "- 全部字段通过检查；审阅后确认。",
          ),
        ]),
    "",
  );
  return lines.join("\n");
}

/** Refresh is the only draft writer; it never changes the project outside `.aris/`. */
export function refreshSetupReview(projectRoot: string, patch?: unknown): SetupReview {
  const root = path.resolve(projectRoot),
    stateFile = statePath(root);
  return withStateFileLock(stateFile, () => {
    const draft = loadDraft(root);
    if (patch !== undefined) {
      if (!isRecord(patch)) failA1("INVALID_VALUE", "configuration changes must be an object");
      draft.configuration = merge(draft.configuration, patch) as JsonObject;
    }
    draft.configuration = completeModules(root, draft.configuration);
    const digest = draftDigest(root, draft),
      previous = readJson(stateFile),
      issues = validateSetupConfiguration(draft.configuration, root),
      role = installedRole(root),
      language = get(draft.configuration, "project.language") === "en" ? "en" : "zh";
    const review: SetupReview = {
      role,
      language,
      draft_path: setupDraftPath(root),
      review_path: path.join(root, ".aris", "setup-review.md"),
      task: { path: taskPath(root), sha256: taskSha256(root) },
      configuration_sha256: digest,
      ready_to_confirm: issues.length === 0,
      confirmed: previous.confirmed_sha256 === digest && issues.length === 0,
      modules: ROLE_MODULES[role].map((id) => ({
        id,
        title: TITLES[id]!.split(" / ")[language === "en" ? 1 : 0]!,
        fields: rows(draft.configuration[id], id, true),
      })),
      issues,
    };
    writeStateJsonAtomic(review.draft_path, draft);
    fs.writeFileSync(review.review_path, markdown(review));
    writeStateJsonAtomic(stateFile, {
      review_sha256: digest,
      confirmed_sha256: review.confirmed ? digest : null,
      status: review.confirmed ? "confirmed" : "review",
      issues,
    });
    return review;
  });
}

export function confirmSetupReview(
  projectRoot: string,
  reviewedDigest: string,
): { status: "confirmed"; configuration_sha256: string } {
  const root = path.resolve(projectRoot),
    stateFile = statePath(root);
  return withStateFileLock(stateFile, () => {
    const draft = loadDraft(root),
      digest = draftDigest(root, draft),
      state = readJson(stateFile);
    if (digest !== reviewedDigest || state.review_sha256 !== digest)
      failA1("SETUP_CONFIGURATION_CHANGED", "refresh and confirm the current configuration");
    const issues = validateSetupConfiguration(draft.configuration, root);
    if (issues.length) throw new SetupReviewIncompleteError(issues);
    writeStateJsonAtomic(stateFile, {
      ...state,
      status: "confirmed",
      confirmed_sha256: digest,
      confirmed_at: new Date().toISOString(),
    });
    return { status: "confirmed", configuration_sha256: digest };
  });
}

function confirmedDraft(root: string): SetupDraft {
  const draft = loadDraft(root),
    digest = draftDigest(root, draft),
    state = readJson(statePath(root));
  if (state.confirmed_sha256 !== digest || state.review_sha256 !== digest)
    failA1(
      "SETUP_CONFIGURATION_CONFIRMATION_REQUIRED",
      "the owner must confirm the current refreshed configuration first",
    );
  const issues = validateSetupConfiguration(draft.configuration, root);
  if (issues.length) throw new SetupReviewIncompleteError(issues);
  return draft;
}

/** Replace only the marked block so the owner's own CLAUDE.md text survives re-runs. */
function writeRoleBlock(root: string, role: SetupRole): void {
  const provider = installedProvider(root);
  const file = path.join(root, provider === "codex" ? "AGENTS.md" : "CLAUDE.md");
  let template = fs
    .readFileSync(path.join(TEMPLATES, `ROLE_${role.toUpperCase()}.md`), "utf8")
    .trim()
    .replaceAll("{{PROJECT_SLUG}}", projectSlug(root));
  if (provider === "codex") template = template.replaceAll(".claude/skills", ".agents/skills");
  const block = `${ROLE_BEGIN}\n${template}\n${ROLE_END}`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = current.indexOf(ROLE_BEGIN),
    end = current.indexOf(ROLE_END);
  const next =
    start >= 0 && end > start
      ? `${current.slice(0, start)}${block}${current.slice(end + ROLE_END.length)}`
      : `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
  fs.writeFileSync(file, next);
}
/** Credentials live in these paths; keep them out of commits and deliverable zips. */
function ensureGitignored(root: string, entries: readonly string[]): void {
  const file = path.join(root, ".gitignore");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(file, `${current}${separator}${missing.map((entry) => `${entry}\n`).join("")}`);
}
/** Add or replace one entry of a JSON object file without touching its other entries. */
function mergeJsonEntry(file: string, key: string, name: string, entry: JsonObject): void {
  const current = readJson(file);
  const section = isRecord(current[key]) ? current[key] : {};
  writeStateJsonAtomic(file, { ...current, [key]: { ...section, [name]: entry } });
}

type SetupEnvironmentResult = {
  /** Where setup's environment step writes the environment skill; apply does not create it. */
  environment_skill_dir: string;
  environment_secrets: string;
  /** The agent settings this role runs with in Paseo. */
  agent: (typeof ROLE_AGENT)[SetupRole];
};

export type SetupApplyResult = SetupEnvironmentResult &
  (
    | { role: "worker"; mcp_config: string }
    | {
        role: "validator";
        validation_config: string;
        service_script: string;
        worker_connection: { url: string; token: string };
      }
  );

/** Apply the confirmed sheet: role block, then the role's own wiring. */
export async function applySetup(projectRoot: string): Promise<SetupApplyResult> {
  const root = path.resolve(projectRoot),
    configuration = confirmedDraft(root).configuration,
    role = installedRole(root);
  const environment = {
    environment_skill_dir: environmentSkillDir(root),
    environment_secrets: environmentSecretsPath(root),
    agent: ROLE_AGENT[role],
  };
  const secrets = Object.entries(get(configuration, "environment.secrets") as JsonObject);
  // A null entry is a cleared secret.
  writeStateJsonAtomic(
    environment.environment_secrets,
    Object.fromEntries(secrets.filter(([, value]) => value !== null)),
  );
  fs.chmodSync(environment.environment_secrets, 0o600);
  ensureGitignored(root, role === "worker" ? [".aris/", ".mcp.json"] : [".aris/"]);
  if (role === "worker") {
    const file = path.join(root, ".mcp.json");
    mergeJsonEntry(file, "mcpServers", "aris-validation", {
      type: "http",
      url: get(configuration, "connection.url"),
      headers: { Authorization: `Bearer ${String(get(configuration, "connection.token"))}` },
    });
    fs.chmodSync(file, 0o600);
    writeRoleBlock(root, role);
    return { role, mcp_config: file, ...environment };
  }
  const validation = configuration.validation as JsonObject;
  if (countedSubmissions(root) > 0) assertBenchmarkIntact(root, readValidationConfig(root));
  const benchmark = await setupTesterFacility(root, validation.benchmark);
  const config = draftValidationConfig(validation, benchmark);
  writeStateJsonAtomic(validationConfigPath(root), config);
  const token = ensureValidationToken(root);
  const port = get(validation, "service.port");
  mergeJsonEntry(path.join(root, "paseo.json"), "scripts", "aris-validation", {
    type: "service",
    command: "node .aris/dist/tools/validation-cli.js serve --project .",
    ...(typeof port === "number" ? { port } : {}),
  });
  writeRoleBlock(root, role);
  return {
    role,
    validation_config: validationConfigPath(root),
    ...environment,
    service_script: "aris-validation",
    worker_connection: { url: `${config.service.public_url}/mcp`, token },
  };
}

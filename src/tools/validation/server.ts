/**
 * The validator machine's public face. Worker agents reach it as a remote MCP
 * server with two tools, `submit` and `query`; deliverables arrive as a plain
 * HTTP PUT to the one-time URL `submit` returns, so Windows' built-in curl.exe
 * is enough. A tick expires stale uploads and starts one validator agent per
 * queued submission. Everything else (scoring, publishing) happens in the CLI.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { A1Error, failA1, isRecord } from "../validate.js";
import {
  readValidationConfig,
  readValidationToken,
  tokenMatches,
  type ValidationConfig,
} from "./config.js";
import { paseoDispatcher, type Dispatcher } from "./dispatch.js";
import { assertBenchmarkIntact } from "./layers.js";
import {
  createSubmission,
  deliverableZip,
  listSubmissions,
  readPublished,
  readSubmission,
  serviceSummary,
  submissionDir,
  unpackedDir,
  updateSubmission,
  withSubmissionsLock,
  type SubmissionRecord,
} from "./store.js";
import { unzipDeliverable } from "./zip.js";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_RPC_BYTES = 1024 * 1024;

export interface ServiceOptions {
  port: number;
  host?: string;
  dispatcher?: Dispatcher;
  tick_ms?: number;
  log?: (line: string) => void;
}
export interface RunningService {
  /** Base URL the service actually listens on (not the public URL). */
  url: string;
  tick(): Promise<void>;
  close(): Promise<void>;
}

const TOOLS = [
  {
    name: "submit",
    description:
      "Reserve one submission and get a one-time upload URL. Upload a zip whose root (or single top-level folder) holds USAGE.md, explaining how to install and run the deliverable. A malformed zip is rejected and does not count against the limit.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Optional short note stored with the submission." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "query",
    description:
      "Service state (open or closed), submissions left and, for one submission, its status, verdict, how many tests it passed out of how many, and feedback on the problems found. The tests themselves stay hidden.",
    inputSchema: {
      type: "object",
      properties: { submission_id: { type: "string", description: "For example s001." } },
      additionalProperties: false,
    },
  },
];

function submitTool(root: string, config: ValidationConfig, args: Record<string, unknown>) {
  // A changed benchmark stops reviews; taking uploads would only drain the budget.
  assertBenchmarkIntact(root, config);
  const note = typeof args.note === "string" ? args.note : undefined;
  const { record, upload_token } = createSubmission(root, config, note);
  const url = `${config.service.public_url}/upload/${record.submission_id}/${upload_token}`;
  return {
    submission_id: record.submission_id,
    upload_url: url,
    expires_at: record.upload!.expires_at,
    upload_command: `curl.exe --fail-with-body -T deliverable.zip "${url}"`,
    remaining: serviceSummary(root, config).remaining,
  };
}

function submissionView(root: string, record: SubmissionRecord) {
  const published = readPublished(root, record.submission_id);
  return {
    submission_id: record.submission_id,
    status: record.status,
    created_at: record.created_at,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.deliverable ? { deliverable_sha256: record.deliverable.sha256 } : {}),
    ...(published
      ? {
          verdict: published.verdict,
          tests: published.tests,
          feedback: published.feedback,
          published_at: published.published_at,
        }
      : {}),
  };
}

function queryTool(
  root: string,
  config: ValidationConfig,
  args: Record<string, unknown>,
  blocked: string | null,
) {
  const service = { ...serviceSummary(root, config), ...(blocked ? { blocked } : {}) };
  if (typeof args.submission_id === "string")
    return {
      service,
      submission: submissionView(root, readSubmission(root, args.submission_id)),
    };
  return {
    service,
    submissions: listSubmissions(root).map((record) => {
      const published = readPublished(root, record.submission_id);
      return {
        submission_id: record.submission_id,
        status: record.status,
        ...(published ? { verdict: published.verdict, tests: published.tests } : {}),
      };
    }),
  };
}

function send(response: http.ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const text = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, { "content-type": "application/json" }).end(text);
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) failA1("REQUEST_TOO_LARGE", `request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startValidationService(
  projectRoot: string,
  options: ServiceOptions,
): Promise<RunningService> {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  assertBenchmarkIntact(root, config);
  const token = readValidationToken(root);
  const dispatch = options.dispatcher ?? paseoDispatcher(config.agent);
  const log = options.log ?? ((line: string) => console.log(line));
  const uploading = new Set<string>();
  let blocked: string | null = null;
  let ticking: Promise<void> | null = null;

  function rpc(message: unknown): object | null {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    const { id, method } = message;
    if (id === undefined) return null; // notifications need no answer
    const params = isRecord(message.params) ? message.params : {};
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      const asked = String(params.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "aris-validation", version: "1.0.0" },
        instructions:
          "Submit deliverables with `submit` (put the commit hash in `note`), upload the zip with the returned curl.exe command, then poll `query` until the submission's status is final. tested, rejected_cheating and unusable carry a verdict; invalid, expired and failed do not count: read `reason`, fix it and submit again. The validator keeps adding hidden tests derived from the problems it finds, so the test total grows; fix the problems the feedback describes rather than chasing a number. Stop only when the state is closed; while reviews are in flight with no submissions remaining, keep polling.",
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") {
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        const result =
          params.name === "submit"
            ? submitTool(root, config, args)
            : params.name === "query"
              ? queryTool(root, config, args, blocked)
              : failA1("UNKNOWN_TOOL", `no tool ${String(params.name)}`);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        const text = error instanceof A1Error ? error.message : "internal error";
        if (!(error instanceof A1Error)) log(`tools/call failed: ${String(error)}`);
        return ok({ content: [{ type: "text", text }], isError: true });
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
  }

  async function handleMcp(request: http.IncomingMessage, response: http.ServerResponse) {
    const auth = request.headers.authorization;
    if (!tokenMatches(token, auth?.startsWith("Bearer ") ? auth.slice(7) : undefined)) {
      send(response, 401, { error: "a valid bearer token is required" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      send(response, 405, { error: "this server does not open event streams" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(request, MAX_RPC_BYTES));
    } catch (error) {
      const code = error instanceof A1Error ? 413 : 400;
      send(response, code, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }
    const replies = (Array.isArray(parsed) ? parsed : [parsed]).map(rpc).filter(Boolean);
    if (!replies.length) send(response, 202);
    else send(response, 200, Array.isArray(parsed) ? replies : replies[0]);
  }

  async function handleUpload(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    id: string,
    presented: string,
  ) {
    let record: SubmissionRecord;
    try {
      record = readSubmission(root, id);
    } catch {
      send(response, 404, { error: "unknown upload URL" });
      return;
    }
    const digest = crypto.createHash("sha256").update(presented).digest("hex");
    if (record.status !== "awaiting_upload" || !tokenMatches(record.upload!.token_sha256, digest)) {
      send(response, 404, { error: "unknown or already used upload URL" });
      return;
    }
    if (Date.parse(record.upload!.expires_at) <= Date.now()) {
      send(response, 410, { error: "this upload URL expired; call submit again" });
      return;
    }
    if (uploading.has(id)) {
      send(response, 409, { error: "an upload to this URL is already in progress" });
      return;
    }
    uploading.add(id);
    const dir = submissionDir(root, id);
    const part = `${deliverableZip(root, id)}.part`;
    const staging = path.join(dir, "unpack-staging");
    const reject = (reason: string) => {
      fs.rmSync(part, { force: true });
      fs.rmSync(deliverableZip(root, id), { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      withSubmissionsLock(root, () => updateSubmission(root, id, { status: "invalid", reason }));
      send(response, 422, { submission_id: id, status: "invalid", reason });
    };
    try {
      const limit = config.limits.max_upload_bytes;
      if (Number(request.headers["content-length"] ?? 0) > limit) {
        request.resume();
        reject(`the zip is larger than ${limit} bytes`);
        return;
      }
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          hash.update(chunk);
          callback(bytes > limit ? new A1Error("TOO_LARGE", "upload too large") : null, chunk);
        },
      });
      try {
        await pipeline(request, meter, fs.createWriteStream(part));
      } catch (error) {
        if (error instanceof A1Error) reject(`the zip is larger than ${limit} bytes`);
        else {
          // A dropped connection leaves the URL usable until it expires.
          fs.rmSync(part, { force: true });
          if (!response.headersSent) send(response, 400, { error: "upload interrupted; retry" });
        }
        return;
      }
      fs.renameSync(part, deliverableZip(root, id));
      let unpacked;
      try {
        unpacked = await unzipDeliverable(deliverableZip(root, id), staging, config.limits);
      } catch (error) {
        reject(error instanceof A1Error ? error.message : `cannot read the zip: ${String(error)}`);
        return;
      }
      fs.renameSync(unpacked.content_root, unpackedDir(root, id));
      fs.rmSync(staging, { recursive: true, force: true });
      const sha256 = hash.digest("hex");
      withSubmissionsLock(root, () =>
        updateSubmission(root, id, {
          status: "queued",
          deliverable: { sha256, bytes, files: unpacked.files },
        }),
      );
      send(response, 200, { submission_id: id, status: "queued", sha256 });
      void tick();
    } finally {
      uploading.delete(id);
    }
  }

  async function runTick(): Promise<void> {
    const now = Date.now();
    const next = withSubmissionsLock(root, () => {
      let reviewing = 0;
      let candidate: SubmissionRecord | null = null;
      for (const record of listSubmissions(root)) {
        const id = record.submission_id;
        if (record.status === "awaiting_upload" && !uploading.has(id)) {
          if (Date.parse(record.upload!.expires_at) <= now)
            updateSubmission(root, id, { status: "expired", reason: "no upload arrived in time" });
        } else if (record.status === "queued") candidate ??= record;
        else if (record.status === "reviewing") {
          const started = Date.parse(record.review_started_at ?? record.updated_at);
          if (now - started > config.limits.review_timeout_minutes * 60_000)
            updateSubmission(root, id, {
              status: "failed",
              reason: "the review did not finish in time; this submission does not count",
            });
          else reviewing += 1;
        }
      }
      if (!candidate || reviewing >= config.limits.max_concurrent) return null;
      try {
        assertBenchmarkIntact(root, config);
        blocked = null;
      } catch (error) {
        blocked = (error as Error).message;
        return null;
      }
      return updateSubmission(root, candidate.submission_id, {
        status: "reviewing",
        review_started_at: new Date().toISOString(),
      });
    });
    if (!next) return;
    const id = next.submission_id;
    try {
      const { agent_id } = await dispatch({
        root,
        submission_id: id,
        submission_dir: submissionDir(root, id),
      });
      withSubmissionsLock(root, () => updateSubmission(root, id, { agent_id }));
      log(`submission ${id}: validator agent ${agent_id}`);
    } catch (error) {
      log(`submission ${id}: dispatch failed: ${String(error)}`);
      withSubmissionsLock(root, () =>
        updateSubmission(root, id, {
          status: "failed",
          reason: "the validator agent could not start; this submission does not count",
        }),
      );
    }
    // Another slot may be free, or another submission queued meanwhile.
    await runTick();
  }

  function tick(): Promise<void> {
    ticking ??= runTick()
      .catch((error) => log(`tick failed: ${String(error)}`))
      .finally(() => {
        ticking = null;
      });
    return ticking;
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const upload = /^\/upload\/(s\d{3,})\/([A-Za-z0-9_-]{16,})$/.exec(url.pathname);
    const handled =
      url.pathname === "/health" && request.method === "GET"
        ? Promise.resolve(send(response, 200, { status: "ok" }))
        : url.pathname === "/mcp"
          ? handleMcp(request, response)
          : upload && request.method === "PUT"
            ? handleUpload(request, response, upload[1]!, upload[2]!)
            : Promise.resolve(send(response, 404, { error: "not found" }));
    handled.catch((error) => {
      log(`request failed: ${String(error)}`);
      if (!response.headersSent) send(response, 500, { error: "internal error" });
      else response.destroy();
    });
  });
  // Large uploads over slow links must not hit Node's default request timeout.
  server.requestTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? config.service.host, () => resolve());
  });
  const address = server.address() as { port: number; address: string };
  const timer = setInterval(() => void tick(), options.tick_ms ?? 5000);
  timer.unref();
  void tick();
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    tick,
    async close() {
      clearInterval(timer);
      await ticking;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

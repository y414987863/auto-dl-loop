/**
 * Submission records on the validator machine. Each submission directory holds
 * one status.json; the service, the CLI and finalize all change it under one lock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStateFile, withStateFileLock, writeStateJsonAtomic } from "../state-file.js";
import { failA1 } from "../validate.js";
import { validationDir, type ValidationConfig } from "./config.js";

export type SubmissionStatus =
  | "awaiting_upload"
  | "queued"
  | "reviewing"
  | "tested"
  | "rejected_cheating"
  | "unusable"
  /** Not counted: the upload never arrived. */
  | "expired"
  /** Not counted: the deliverable was malformed (zip, size, USAGE.md). */
  | "invalid"
  /** Not counted: our side failed (agent could not start, review timed out). */
  | "failed";

export interface SubmissionRecord {
  schema_version: 1;
  submission_id: string;
  status: SubmissionStatus;
  created_at: string;
  updated_at: string;
  note?: string;
  upload?: { token_sha256: string; expires_at: string };
  deliverable?: { sha256: string; bytes: number; files: number };
  agent_id?: string;
  review_started_at?: string;
  /** Latest full run of each benchmark layer, by layer id; finalize counts these. */
  evaluations?: Record<string, string>;
  /** Independent cross-checks of feedback.md, oldest first. */
  leak_reviews?: LeakReview[];
  /** Public reason for expired, invalid and failed. */
  reason?: string;
}

export interface LeakReview {
  attempt: number;
  /** The feedback.md this reviewer was given; a later edit needs a new review. */
  feedback_sha256: string;
  agent_id: string;
  dir: string;
  requested_at: string;
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
}

export type Verdict = "valid" | "cheating" | "unusable";
export interface PublishedResult {
  schema_version: 2;
  submission_id: string;
  verdict: Verdict;
  /** Null unless the verdict is valid; a cheating verdict voids every measured test. */
  tests: TestCounts | null;
  /** Empty when every rewrite still leaked hidden data. */
  feedback: string;
  published_at: string;
}

export const COUNTED: readonly SubmissionStatus[] = [
  "queued",
  "reviewing",
  "tested",
  "rejected_cheating",
  "unusable",
];
const FINAL: readonly SubmissionStatus[] = [
  "tested",
  "rejected_cheating",
  "unusable",
  "expired",
  "invalid",
  "failed",
];
const SUBMISSION_ID = /^s\d{3,}$/;

export const submissionsDir = (root: string): string =>
  path.join(validationDir(root), "submissions");
export function submissionDir(root: string, id: string): string {
  if (!SUBMISSION_ID.test(id)) failA1("UNKNOWN_SUBMISSION", `no submission ${id}`);
  return path.join(submissionsDir(root), id);
}
const statusFile = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "status.json");
export const publishedFile = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "published.json");
export const deliverableZip = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "deliverable.zip");
export const unpackedDir = (root: string, id: string): string =>
  path.join(submissionDir(root, id), "unpacked");

/** Every read-modify-write of submission records goes through this one lock. */
export function withSubmissionsLock<T>(root: string, action: () => T): T {
  return withStateFileLock(submissionsDir(root), action);
}

export function readSubmission(root: string, id: string): SubmissionRecord {
  const file = statusFile(root, id);
  if (!fs.existsSync(file)) failA1("UNKNOWN_SUBMISSION", `no submission ${id}`);
  return readStateFile<SubmissionRecord>(file);
}
export function listSubmissions(root: string): SubmissionRecord[] {
  const dir = submissionsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => SUBMISSION_ID.test(name) && fs.existsSync(statusFile(root, name)))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map((name) => readSubmission(root, name));
}
export function readPublished(root: string, id: string): PublishedResult | null {
  const file = publishedFile(root, id);
  return fs.existsSync(file) ? readStateFile<PublishedResult>(file) : null;
}
export function countedSubmissions(root: string): number {
  return listSubmissions(root).filter((record) => COUNTED.includes(record.status)).length;
}

/** Caller holds the lock. Final records never change again. */
export function updateSubmission(
  root: string,
  id: string,
  change: Partial<SubmissionRecord>,
): SubmissionRecord {
  const current = readSubmission(root, id);
  if (FINAL.includes(current.status))
    failA1("SUBMISSION_FINAL", `submission ${id} is already ${current.status}`);
  const next = { ...current, ...change, updated_at: new Date().toISOString() };
  writeStateJsonAtomic(statusFile(root, id), next);
  return next;
}

/** Validation only ends when the counted submissions run out. */
export type ServiceState = "open" | "closed";
export interface ServiceSummary {
  state: ServiceState;
  max_submissions: number;
  counted: number;
  /** Slots left after counted submissions and live upload reservations. */
  remaining: number;
}

export function serviceSummary(root: string, config: ValidationConfig): ServiceSummary {
  const records = listSubmissions(root),
    now = Date.now();
  const counted = records.filter((record) => COUNTED.includes(record.status)).length;
  const reserved = records.filter(
    (record) => record.status === "awaiting_upload" && Date.parse(record.upload!.expires_at) > now,
  ).length;
  const inFlight = records.some((record) => ["queued", "reviewing"].includes(record.status));
  return {
    state: counted >= config.limits.max_submissions && !inFlight ? "closed" : "open",
    max_submissions: config.limits.max_submissions,
    counted,
    remaining: Math.max(0, config.limits.max_submissions - counted - reserved),
  };
}

/** Reserve a slot and an upload URL token. Refused once no submissions remain. */
export function createSubmission(
  root: string,
  config: ValidationConfig,
  note: string | undefined,
): { record: SubmissionRecord; upload_token: string } {
  return withSubmissionsLock(root, () => {
    const summary = serviceSummary(root, config);
    if (summary.remaining < 1) failA1("SUBMISSION_LIMIT", "no submissions remain");
    const records = listSubmissions(root);
    const last = records.at(-1);
    const id = `s${String((last ? Number(last.submission_id.slice(1)) : 0) + 1).padStart(3, "0")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const now = new Date();
    const record: SubmissionRecord = {
      schema_version: 1,
      submission_id: id,
      status: "awaiting_upload",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      ...(note ? { note: note.slice(0, 2000) } : {}),
      upload: {
        token_sha256: crypto.createHash("sha256").update(token).digest("hex"),
        expires_at: new Date(
          now.getTime() + config.limits.upload_ttl_minutes * 60_000,
        ).toISOString(),
      },
    };
    fs.mkdirSync(submissionDir(root, id), { recursive: true });
    writeStateJsonAtomic(statusFile(root, id), record);
    return { record, upload_token: token };
  });
}

export function publish(root: string, result: PublishedResult): void {
  if ((result.verdict === "valid") !== (result.tests !== null))
    failA1("INVALID_RESULT", "exactly the valid verdicts carry test counts");
  if (result.tests && result.tests.passed + result.tests.failed !== result.tests.total)
    failA1("INVALID_RESULT", "passed and failed tests must add up to the total");
  writeStateJsonAtomic(publishedFile(root, result.submission_id), result);
}

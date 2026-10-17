/**
 * Feedback leaves this machine only after a second agent, which did not write
 * it, has read it against the hidden tests and found no test case in it. Each
 * request snapshots feedback.md into its own directory and binds the review to
 * that text's digest, so editing the feedback afterwards needs a new review.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStateFile } from "../state-file.js";
import { failA1, isRecord } from "../validate.js";
import { readValidationConfig } from "./config.js";
import { leakReviewRun, paseoStarter, type AgentStarter } from "./dispatch.js";
import {
  readSubmission,
  submissionDir,
  updateSubmission,
  withSubmissionsLock,
  type LeakReview,
  type SubmissionRecord,
} from "./store.js";

export interface LeakVerdict {
  verdict: "pass" | "leak";
  findings: string[];
}

export function feedbackText(dir: string): string {
  const file = path.join(dir, "feedback.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}
export const textSha256 = (text: string): string =>
  crypto.createHash("sha256").update(text).digest("hex");

/** The reviewer's result, or null while it is still working. */
export function readLeakVerdict(review: LeakReview): LeakVerdict | null {
  const file = path.join(review.dir, "result.json");
  if (!fs.existsSync(file)) return null;
  const value = readStateFile<unknown>(file);
  if (
    !isRecord(value) ||
    !["pass", "leak"].includes(String(value.verdict)) ||
    !Array.isArray(value.findings) ||
    value.findings.some((item) => typeof item !== "string") ||
    (value.verdict === "leak" && !value.findings.length)
  )
    failA1(
      "INVALID_LEAK_REVIEW",
      `${file} must be {"verdict": "pass"|"leak", "findings": ["..."]}, with findings for a leak`,
    );
  return { verdict: value.verdict as LeakVerdict["verdict"], findings: value.findings as string[] };
}

export function leaksFound(record: SubmissionRecord): number {
  return (record.leak_reviews ?? []).filter((review) => readLeakVerdict(review)?.verdict === "leak")
    .length;
}

export async function requestLeakReview(
  projectRoot: string,
  id: string,
  start?: AgentStarter,
): Promise<LeakReview & { result_file: string }> {
  const root = path.resolve(projectRoot);
  const config = readValidationConfig(root);
  const record = readSubmission(root, id);
  if (record.status !== "reviewing")
    failA1("SUBMISSION_NOT_IN_REVIEW", `submission ${id} is ${record.status}`);
  const dir = submissionDir(root, id);
  const feedback = feedbackText(dir);
  if (!feedback) failA1("FEEDBACK_EMPTY", "an empty feedback.md is published without review");
  if (leaksFound(record) > config.limits.feedback_attempts)
    failA1(
      "LEAK_REVIEWS_EXHAUSTED",
      "every permitted rewrite leaked; finalize publishes the result without feedback",
    );
  const attempt = (record.leak_reviews?.length ?? 0) + 1;
  const reviewDir = path.join(dir, "leak-review", String(attempt));
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "feedback.md"), `${feedback}\n`);
  const { agent_id } = await (start ?? paseoStarter(config.agent))(
    leakReviewRun({ root, submission_id: id, submission_dir: dir, review_dir: reviewDir }),
  );
  const review: LeakReview = {
    attempt,
    feedback_sha256: textSha256(feedback),
    agent_id,
    dir: reviewDir,
    requested_at: new Date().toISOString(),
  };
  withSubmissionsLock(root, () =>
    updateSubmission(root, id, {
      leak_reviews: [...(readSubmission(root, id).leak_reviews ?? []), review],
    }),
  );
  return { ...review, result_file: path.join(reviewDir, "result.json") };
}

/**
 * What finalize may publish: the feedback once the latest review of exactly
 * this text passed, nothing once every permitted rewrite leaked.
 */
export function clearedFeedback(
  record: SubmissionRecord,
  feedback: string,
  attempts: number,
): { feedback: string; withheld: boolean } {
  if (!feedback) return { feedback: "", withheld: false };
  const latest = record.leak_reviews?.at(-1);
  if (!latest || latest.feedback_sha256 !== textSha256(feedback))
    failA1("LEAK_REVIEW_REQUIRED", "run leak-review on the current feedback.md first");
  const result = readLeakVerdict(latest);
  if (!result) failA1("LEAK_REVIEW_PENDING", `wait for ${path.join(latest.dir, "result.json")}`);
  if (result.verdict === "pass") return { feedback, withheld: false };
  const leaks = leaksFound(record);
  if (leaks <= attempts)
    failA1(
      "FEEDBACK_LEAKS_HIDDEN_DATA",
      `the leak reviewer found test cases in feedback.md; rewrite it and run leak-review again (${attempts - leaks + 1} attempts left). Findings: ${JSON.stringify(result.findings)}`,
    );
  return { feedback: "", withheld: true };
}

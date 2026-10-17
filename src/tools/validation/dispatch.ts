/**
 * Start validator-side agents through the local Paseo CLI, so they appear in
 * the Paseo app next to the service: one review agent per submission, and a
 * separate leak reviewer for each feedback draft. No shell is involved: the
 * command is an argv list from the frozen config.
 */
import { execFile } from "node:child_process";
import { failA1 } from "../validate.js";
import type { ValidationAgentConfig } from "./config.js";

export interface AgentRun {
  root: string;
  title: string;
  labels: Record<string, string>;
  prompt: string;
}
export type AgentStarter = (run: AgentRun) => Promise<{ agent_id: string }>;

export interface DispatchRequest {
  root: string;
  submission_id: string;
  submission_dir: string;
}
export type Dispatcher = (request: DispatchRequest) => Promise<{ agent_id: string }>;

export function reviewRun(request: DispatchRequest): AgentRun {
  return {
    root: request.root,
    title: `ARIS validation ${request.submission_id}`,
    labels: { "aris.role": "validator", "aris.submission": request.submission_id },
    prompt: [
      `Review ARIS validation submission ${request.submission_id}.`,
      `Submission directory: ${request.submission_dir}`,
      "Follow the validation-review skill from start to finish, ending with finalize.",
    ].join("\n"),
  };
}

export function leakReviewRun(request: {
  root: string;
  submission_id: string;
  submission_dir: string;
  review_dir: string;
}): AgentRun {
  return {
    root: request.root,
    title: `ARIS leak review ${request.submission_id}`,
    labels: { "aris.role": "leak-review", "aris.submission": request.submission_id },
    prompt: [
      `Cross-check the feedback of ARIS validation submission ${request.submission_id} before it reaches the worker.`,
      `Feedback to check: ${request.review_dir}/feedback.md`,
      `Submission directory: ${request.submission_dir}`,
      `Follow .agents/skills/validation-review/leak-review.md and write ${request.review_dir}/result.json; change nothing else.`,
    ].join("\n"),
  };
}

export function paseoRunArgv(agent: ValidationAgentConfig, run: AgentRun): string[] {
  const optional = (flag: string, value: string | undefined) => (value ? [flag, value] : []);
  return [
    ...agent.paseo_command,
    "run",
    "-d",
    "--json",
    "--title",
    run.title,
    "--provider",
    agent.provider,
    "--thinking",
    agent.thinking,
    ...optional("--model", agent.model),
    ...optional("--mode", agent.mode),
    "--cwd",
    run.root,
    ...Object.entries(run.labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    run.prompt,
  ];
}

export function paseoStarter(agent: ValidationAgentConfig): AgentStarter {
  return (run) =>
    new Promise((resolve, reject) => {
      const [command, ...args] = paseoRunArgv(agent, run);
      const env = { ...process.env };
      // Inside a Paseo agent this would make the new agent our child; it must stand alone.
      delete env.PASEO_AGENT_ID;
      execFile(
        command!,
        args,
        { cwd: run.root, env, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`paseo run failed: ${String(stderr || error.message).trim()}`));
            return;
          }
          try {
            const parsed = JSON.parse(String(stdout)) as { agentId?: unknown };
            if (typeof parsed.agentId !== "string" || !parsed.agentId)
              failA1("DISPATCH_FAILED", "paseo run did not report an agent id");
            resolve({ agent_id: parsed.agentId });
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
}

export function paseoDispatcher(agent: ValidationAgentConfig): Dispatcher {
  const start = paseoStarter(agent);
  return (request) => start(reviewRun(request));
}

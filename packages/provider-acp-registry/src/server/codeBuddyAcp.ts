/**
 * WorkBuddy/CodeBuddy's ACP shape for delegated work.
 *
 * The agent reports a worker through two plain tools instead of dedicated ACP
 * subagent metadata: `Agent` starts one and answers with its `agent_id`, and
 * `TaskOutput` polls one by that id. Without a flavor that reads those shapes
 * both calls project as anonymous dynamic tools ("Tool"/"Tool"), so a running
 * worker never reaches the thread's subagent roster.
 */
import { unknownRecord } from "@t3tools/provider-acp/server/clientPolicy";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

const DISPATCH_AGENT_ID_PATTERNS = [
  /agent_id:\s*(agent-[0-9a-f-]+)/u,
  /\[Agent ID:\s*(agent-[0-9a-f-]+)\]/u,
] as const;

const TASK_OUTPUT_STATUS_PATTERN = /Status:\s*(\w+)/u;

const TASK_OUTPUT_STATUSES: Readonly<Record<string, AcpAdapterV2SubagentUpdate["status"]>> = {
  running: "running",
  completed: "completed",
  cancelled: "cancelled",
  failed: "failed",
};

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Output text of a tool call, in the precedence the ACP runtime reports it:
 * a structured `rawOutput`, a raw string, then the content block array.
 */
function toolOutputText(tool: AcpToolCallState): string | undefined {
  const rawOutput = unknownRecord(tool.data.rawOutput);
  if (rawOutput !== undefined) {
    const direct = nonEmptyString(rawOutput.text) ?? nonEmptyString(rawOutput.output_for_prompt);
    if (direct !== undefined) return direct;
  }
  if (typeof tool.data.rawOutput === "string") {
    return nonEmptyString(tool.data.rawOutput);
  }
  const content = tool.data.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((entry) => {
      const block = unknownRecord(entry);
      const nested = unknownRecord(block?.content);
      return nonEmptyString(nested?.text) ?? nonEmptyString(block?.text) ?? [];
    })
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

/** The id the `Agent` tool prints once it has a worker: `agent-<hex>`. */
function dispatchAgentId(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  for (const pattern of DISPATCH_AGENT_ID_PATTERNS) {
    const match = pattern.exec(output);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/**
 * `TaskOutput` polls a worker by the id `Agent` returned. A terminal status
 * carries the full report; a running poll is a hydration frame that only
 * refreshes a worker this thread already knows about.
 */
function taskOutputUpdate(
  taskId: string,
  output: string | undefined,
): AcpAdapterV2SubagentUpdate | undefined {
  if (!taskId.startsWith("agent-")) return undefined;
  const reported = output === undefined ? undefined : TASK_OUTPUT_STATUS_PATTERN.exec(output)?.[1];
  const status = (reported === undefined ? "running" : TASK_OUTPUT_STATUSES[reported]) ?? "running";
  return {
    nativeTaskId: taskId,
    childSessionId: null,
    prompt: "",
    title: null,
    model: null,
    status,
    result: TERMINAL_STATUSES.has(status) ? (output ?? null) : null,
    // The poll is the user's only view of a running worker's output.
    suppressNormalTool: false,
  };
}

export function extractCodeBuddySubagentUpdate(
  tool: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const rawInput = unknownRecord(tool.data.rawInput);
  if (rawInput === undefined) return undefined;
  const output = toolOutputText(tool);

  const taskId = nonEmptyString(rawInput.task_id);
  if (taskId !== undefined) return taskOutputUpdate(taskId, output);

  // Starting a worker, not polling one. The dispatcher's own shape is the gate:
  // other registry agents' tool traffic never carries both fields.
  const subagentType = nonEmptyString(rawInput.subagent_type);
  const prompt = nonEmptyString(rawInput.prompt);
  if (subagentType === undefined || prompt === undefined) return undefined;
  const nativeTaskId = dispatchAgentId(output);
  // A dispatch without an id is not attributable to a worker yet; a row keyed
  // on anything else would collide with every other worker's.
  if (nativeTaskId === undefined) return undefined;
  const status =
    tool.status === "failed"
      ? "failed"
      : rawInput.run_in_background === true
        ? // The dispatch tool returns as soon as the worker is detached.
          "running"
        : tool.status === "completed"
          ? "completed"
          : "running";
  return {
    nativeTaskId,
    childSessionId: null,
    prompt,
    title:
      nonEmptyString(rawInput.name) ??
      nonEmptyString(rawInput.worker_name) ??
      nonEmptyString(rawInput.description) ??
      null,
    model: null,
    status,
    result: status === "completed" ? (output ?? null) : null,
  };
}

export interface CodeBuddyTaskNotification {
  readonly nativeTaskId: string;
  readonly status: "completed" | "cancelled" | "failed";
  readonly summary: string | null;
}

const TASK_NOTIFICATION_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "failed",
]);

const TASK_NOTIFICATION_TASK_ID = /<task-id>\s*([^<\s][^<]*?)\s*<\/task-id>/u;
const TASK_NOTIFICATION_STATUS = /<status>\s*([a-z_]+)\s*<\/status>/u;
const TASK_NOTIFICATION_SUMMARY = /<summary>\s*([\s\S]*?)\s*<\/summary>/u;

/**
 * CodeBuddy reports a finished worker by injecting a `<task-notification>` user
 * message into the owning session after the root turn already returned
 * end_turn. That message is the only signal that a detached worker is gone, so
 * it has to parse into the same terminal state the tool calls use.
 */
export function parseCodeBuddyTaskNotification(
  text: string,
): CodeBuddyTaskNotification | undefined {
  if (!text.includes("<task-notification>")) return undefined;
  const nativeTaskId = TASK_NOTIFICATION_TASK_ID.exec(text)?.[1];
  const status = TASK_NOTIFICATION_STATUS.exec(text)?.[1]?.toLowerCase();
  if (nativeTaskId === undefined || status === undefined) return undefined;
  // Non-worker task ids belong to other task kinds and have their own paths.
  if (!nativeTaskId.startsWith("agent-") || !TASK_NOTIFICATION_STATUSES.has(status)) {
    return undefined;
  }
  const summary = TASK_NOTIFICATION_SUMMARY.exec(text)?.[1]?.trim();
  return {
    nativeTaskId,
    status: status as CodeBuddyTaskNotification["status"],
    summary: summary === undefined || summary.length === 0 ? null : summary,
  };
}

/**
 * The adapter's end-notice shape for a CodeBuddy worker: the notification names
 * the worker by its native task id, which is how the roster keys it.
 */
export function extractCodeBuddySubagentEndNotice(text: string):
  | {
      readonly childSessionId: string;
      readonly status: "completed" | "cancelled" | "failed";
      readonly result: string | null;
    }
  | undefined {
  const notification = parseCodeBuddyTaskNotification(text);
  if (notification === undefined) return undefined;
  return {
    childSessionId: notification.nativeTaskId,
    status: notification.status,
    result: notification.summary,
  };
}

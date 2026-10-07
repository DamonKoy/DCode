/**
 * Pure fold behind the Agents board: one thread's delegated and native
 * subagents as board rows, plus the column each row belongs to.
 *
 * The composer pill answers "what is this turn doing" and the lineage list is
 * a flat roster; neither keeps work in flight apart from work that is blocked
 * on the user and work that already finished. That split is the whole job of
 * the board, so it lives here as a fold over `subagents` plus the child thread
 * shells, with no component state of its own.
 */
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
} from "@t3tools/contracts";
import {
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";

export const AGENTS_BOARD_COLUMNS = ["working", "waiting", "done", "failed"] as const;

export type AgentsBoardColumnId = (typeof AGENTS_BOARD_COLUMNS)[number];

export const AGENTS_BOARD_COLUMN_LABELS: Readonly<Record<AgentsBoardColumnId, string>> = {
  working: "Working",
  waiting: "Waiting on you",
  done: "Done",
  failed: "Failed",
};

/**
 * Card-level wording, which is finer than the column: a lane header says
 * "Done" for a whole lane, while a card still has to separate a finished
 * subagent from one that is merely idle and can be resumed.
 */
export const AGENTS_BOARD_STATUS_LABELS: Readonly<Record<RuntimeSubagentStatus, string>> = {
  pending: "Queued",
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export interface AgentsBoardRow {
  readonly id: string;
  readonly agent: RuntimeSubagent;
  readonly driver: ProviderDriverKind | null;
  readonly providerInstanceId: string | null;
  /** The child conversation, when the subagent got its own thread. */
  readonly childThreadId: string | null;
}

export interface AgentsBoardColumn {
  readonly id: AgentsBoardColumnId;
  readonly label: string;
  readonly rows: ReadonlyArray<AgentsBoardRow>;
}

/**
 * Idle is neither running nor finished, so it lands in Done and the card's own
 * status label keeps it honest — an idle row must never read as completed work.
 */
export function agentsBoardColumnForStatus(status: RuntimeSubagentStatus): AgentsBoardColumnId {
  switch (status) {
    case "waiting":
      return "waiting";
    case "completed":
    case "idle":
      return "done";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
    default:
      return "working";
  }
}

/**
 * A child thread's own run outlives the delegated task that created it: the
 * parent can keep sending follow-ups after the task settled. While that run is
 * live the board reports it, and drops the settled task's output because it
 * belongs to the earlier run.
 */
function withChildThreadRun(
  row: AgentsBoardRow,
  childThread: OrchestrationV2ThreadShell | undefined,
): AgentsBoardRow {
  const liveStatus = childThread?.activityRunStatus;
  if (liveStatus === undefined || liveStatus === null) return row;
  const startedAt = childThread?.activityRunStartedAt ?? null;
  return {
    ...row,
    agent: {
      ...row.agent,
      status: liveStatus === "waiting" ? "waiting" : "running",
      startedAt: startedAt === null ? null : DateTime.formatIso(startedAt),
      completedAt: null,
      progress: null,
      result: null,
      error: null,
    },
  };
}

const SHELL_STATUS_TO_SUBAGENT_STATUS: Readonly<Record<string, RuntimeSubagentStatus>> = {
  idle: "idle",
  preparing: "running",
  queued: "pending",
  starting: "running",
  running: "running",
  waiting: "waiting",
  completed: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
  rolled_back: "interrupted",
};

/** A subagent thread with no subagent record in this thread's projection. */
function rowFromChildThread(thread: OrchestrationV2ThreadShell): AgentsBoardRow {
  const updatedAt = DateTime.formatIso(thread.updatedAt);
  const startedAt = thread.activityRunStartedAt ?? thread.latestRunStartedAt ?? null;
  return {
    id: `thread:${thread.id}`,
    agent: {
      id: thread.id,
      kind: "subagent",
      title: thread.title,
      role: null,
      model: thread.modelSelection.model,
      effort: null,
      status: SHELL_STATUS_TO_SUBAGENT_STATUS[thread.status] ?? "idle",
      activationCount: 1,
      usage: null,
      progress: null,
      lastToolName: null,
      result: null,
      error: thread.lastError ?? null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: null,
      phases: [],
      runHandles: null,
      recentActivity: [],
      firstSeenAt: startedAt === null ? updatedAt : DateTime.formatIso(startedAt),
      startedAt: startedAt === null ? null : DateTime.formatIso(startedAt),
      completedAt:
        thread.latestRunCompletedAt === null || thread.latestRunCompletedAt === undefined
          ? null
          : DateTime.formatIso(thread.latestRunCompletedAt),
      updatedAt,
    },
    driver: null,
    providerInstanceId: thread.providerInstanceId,
    childThreadId: thread.id,
  };
}

/** Runtime rows carry ISO strings, so ordering parses them rather than re-wrapping. */
function orderKey(row: AgentsBoardRow): number {
  const parsed = Date.parse(row.agent.startedAt ?? row.agent.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Rows for the whole thread, oldest activation first so a board column reads
 * top-down as the order work was handed out.
 */
export function buildAgentsBoardRows(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly childThreads: ReadonlyMap<string, OrchestrationV2ThreadShell>;
}): ReadonlyArray<AgentsBoardRow> {
  const rows: AgentsBoardRow[] = [];
  const claimedChildThreadIds = new Set<string>();
  const runtimeSubagents = projectedSubagentsToRuntime(input.subagents);
  for (let index = 0; index < runtimeSubagents.length; index += 1) {
    const subagent = input.subagents[index]!;
    const childThreadId = subagent.childThreadId;
    if (childThreadId !== null) claimedChildThreadIds.add(childThreadId);
    rows.push(
      withChildThreadRun(
        {
          id: `subagent:${subagent.id}`,
          agent: runtimeSubagents[index]!,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          childThreadId,
        },
        childThreadId === null ? undefined : input.childThreads.get(childThreadId),
      ),
    );
  }
  // Provider-native children are real threads too; without a subagent record
  // the shell is the only place their status lives.
  for (const thread of input.childThreads.values()) {
    if (claimedChildThreadIds.has(thread.id)) continue;
    rows.push(withChildThreadRun(rowFromChildThread(thread), thread));
  }
  return rows.toSorted(
    (left, right) => orderKey(left) - orderKey(right) || left.id.localeCompare(right.id),
  );
}

/**
 * Rows per column for the current render, plus the summary counts. A column
 * disappears only when it is empty *and* was never used in this render.
 */
export function groupAgentsBoardRows(
  rows: ReadonlyArray<AgentsBoardRow>,
): ReadonlyArray<AgentsBoardColumn> {
  return AGENTS_BOARD_COLUMNS.map((id) => ({
    id,
    label: AGENTS_BOARD_COLUMN_LABELS[id],
    rows: rows.filter((row) => agentsBoardColumnForStatus(row.agent.status) === id),
  }));
}

export interface AgentsBoardSummary {
  readonly total: number;
  readonly working: number;
  readonly waiting: number;
  readonly failed: number;
}

export function summarizeAgentsBoard(rows: ReadonlyArray<AgentsBoardRow>): AgentsBoardSummary {
  let working = 0;
  let waiting = 0;
  let failed = 0;
  for (const row of rows) {
    const column = agentsBoardColumnForStatus(row.agent.status);
    if (column === "working") working += 1;
    else if (column === "waiting") waiting += 1;
    else if (column === "failed") failed += 1;
  }
  return { total: rows.length, working, waiting, failed };
}

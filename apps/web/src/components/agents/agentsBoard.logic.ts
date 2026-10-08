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
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import type { MessageKey } from "@t3tools/shared/i18n";

export const AGENTS_BOARD_COLUMNS = ["working", "waiting", "done", "failed"] as const;

export type AgentsBoardColumnId = (typeof AGENTS_BOARD_COLUMNS)[number];

/**
 * Copy lives in the dictionaries, not here: the fold stays pure and a reader of
 * either board gets translated lanes through `useI18n`.
 */
export const AGENTS_BOARD_COLUMN_LABEL_KEYS: Readonly<Record<AgentsBoardColumnId, MessageKey>> = {
  working: "agents.column.working",
  waiting: "agents.column.waiting",
  done: "agents.column.done",
  failed: "agents.column.failed",
};

/**
 * Card-level wording, which is finer than the column: a lane header says
 * "Done" for a whole lane, while a card still has to separate a finished
 * subagent from one that is merely idle and can be resumed.
 */
export const AGENTS_BOARD_STATUS_LABEL_KEYS: Readonly<Record<RuntimeSubagentStatus, MessageKey>> = {
  pending: "agents.status.pending",
  running: "agents.status.running",
  waiting: "agents.status.waiting",
  idle: "agents.status.idle",
  completed: "agents.status.completed",
  failed: "agents.status.failed",
  cancelled: "agents.status.cancelled",
  interrupted: "agents.status.interrupted",
};

export interface AgentsBoardRow {
  readonly id: string;
  readonly agent: RuntimeSubagent;
  readonly driver: ProviderDriverKind | null;
  readonly providerInstanceId: string | null;
  /** The child conversation, when the subagent got its own thread. */
  readonly childThreadId: string | null;
}

export interface AgentsBoardColumn<Row = AgentsBoardRow> {
  readonly id: AgentsBoardColumnId;
  readonly rows: ReadonlyArray<Row>;
}

/** Any row shape works: the lanes only need a status to file a row under. */
type StatusBearingRow = { readonly agent: { readonly status: RuntimeSubagentStatus } };

/**
 * Rows per column for the current render. A lane disappears only when it is
 * empty; row order is the caller's, so a board can present in-flight work
 * oldest-first and settled work newest-first.
 */

/**
 * Idle is neither running nor finished. Filing it under Done made a board of
 * live-but-quiet workers read "Done (5)" with every card saying "Idle", so it
 * waits alongside work parked on the user; only completed work is Done.
 */
export function agentsBoardColumnForStatus(status: RuntimeSubagentStatus): AgentsBoardColumnId {
  switch (status) {
    case "waiting":
    case "idle":
      return "waiting";
    case "completed":
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
  pending: "pending",
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

/**
 * The runtime row for a subagent child thread. Threads carry their own run
 * status, so this covers both a child the projection already knows about and a
 * provider-native child that only ever appears in the shell snapshot.
 */
export function runtimeSubagentFromThread(thread: OrchestrationV2ThreadShell): RuntimeSubagent {
  const updatedAt = DateTime.formatIso(thread.updatedAt);
  const startedAt = thread.activityRunStartedAt ?? thread.latestRunStartedAt ?? null;
  // A provider-native child never owns a run, so its shell status is always
  // idle; the status of its own root turn is the real one.
  const providerChildStatus =
    thread.latestRunId === null ? (thread.providerChildStatus ?? null) : null;
  const completedAtSource =
    providerChildStatus === null
      ? thread.latestRunCompletedAt
      : (thread.providerChildCompletedAt ?? null);
  return {
    id: thread.id,
    kind: "subagent",
    title: thread.title,
    role: null,
    model: thread.modelSelection.model,
    effort: null,
    status: SHELL_STATUS_TO_SUBAGENT_STATUS[providerChildStatus ?? thread.status] ?? "idle",
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
      completedAtSource === null || completedAtSource === undefined
        ? null
        : DateTime.formatIso(completedAtSource),
    updatedAt,
  };
}

/** A subagent thread with no subagent record in this thread's projection. */
function rowFromChildThread(thread: OrchestrationV2ThreadShell): AgentsBoardRow {
  return {
    id: `thread:${thread.id}`,
    agent: runtimeSubagentFromThread(thread),
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

export function groupAgentsBoardRows<Row extends StatusBearingRow>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<AgentsBoardColumn<Row>> {
  return AGENTS_BOARD_COLUMNS.map((id) => ({
    id,
    rows: rows.filter((row) => agentsBoardColumnForStatus(row.agent.status) === id),
  }));
}

export interface AgentsBoardSummary {
  readonly total: number;
  readonly working: number;
  readonly waiting: number;
  readonly failed: number;
}

export function summarizeAgentsBoard(rows: ReadonlyArray<StatusBearingRow>): AgentsBoardSummary {
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

/**
 * Connection state for the selected agent's in-page detail. Kept apart from the
 * task status on purpose: a dropped connection (`cached`) means the client is
 * showing the last synchronized output, not that the agent stopped. Folding the
 * two together would report a running agent as failed the moment the socket
 * blinks.
 */
export type AgentDetailConnectionState = "live" | "connecting" | "interrupted" | "pending" | "gone";

export function resolveAgentDetailConnectionState(
  status: EnvironmentThreadStatus,
): AgentDetailConnectionState {
  switch (status) {
    case "live":
      return "live";
    case "synchronizing":
      return "connecting";
    case "cached":
      return "interrupted";
    case "deleted":
      return "gone";
    case "empty":
      return "pending";
  }
}

export const AGENT_DETAIL_CONNECTION_LABEL_KEYS: Readonly<
  Record<AgentDetailConnectionState, MessageKey>
> = {
  live: "agents.detail.connection.live",
  connecting: "agents.detail.connection.connecting",
  interrupted: "agents.detail.connection.interrupted",
  pending: "agents.detail.connection.pending",
  gone: "agents.detail.connection.gone",
};

/**
 * Tool and execution items fold behind a disclosure; everything else reads as
 * text. The split is by item type rather than by whether the item has detail:
 * an assistant message with no body should still render as an empty line, not
 * as a collapse that opens to nothing.
 */
const AGENT_DETAIL_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_search",
  "web_search",
  "file_change",
]);

export function agentDetailItemKind(itemType: string): "text" | "tool" {
  return AGENT_DETAIL_TOOL_ITEM_TYPES.has(itemType) ? "tool" : "text";
}

/**
 * Whether a scroll container sits at its latest output. The detail's follow
 * mode reads this on scroll: scrolling up past the threshold turns following
 * off, so new output stops yanking the viewport away from what the reader is
 * reading.
 */
export function isScrolledToLatest(input: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 48;
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}

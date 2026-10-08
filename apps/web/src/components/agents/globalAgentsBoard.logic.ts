/**
 * Pure fold behind the Agents page: every subagent thread across every
 * connected environment, as board rows.
 *
 * The per-thread board answers "what is this conversation delegating"; this one
 * answers "what is the fleet doing right now" across projects and servers. It
 * reads only the shell snapshot the client already holds, so the page costs no
 * request of its own and stays live through the same updates the sidebar uses.
 *
 * A subagent appears here once it owns a thread. An app-owned task that never
 * got one is visible on its parent's thread board instead.
 */
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";

import { runtimeSubagentFromThread, type AgentsBoardColumn } from "./agentsBoard.logic.ts";

export interface GlobalAgentRow {
  /** Environment-scoped, so two servers cannot collapse into one row. */
  readonly id: string;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string | null;
  readonly parentThreadId: ThreadId | null;
  readonly parentThreadTitle: string | null;
  readonly agent: RuntimeSubagent;
}

export interface GlobalAgentsBoardInput {
  /** The shell snapshot: every thread of every connected environment. */
  readonly threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly source: OrchestrationV2ThreadShell;
  }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly environmentId: EnvironmentId;
  }>;
}

function startedKey(agent: RuntimeSubagent): number {
  const parsed = Date.parse(agent.startedAt ?? agent.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function finishedKey(agent: RuntimeSubagent): number {
  const parsed = Date.parse(agent.completedAt ?? agent.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Live work first, oldest first, so the lane reads as the order work went out;
 * settled work after it, newest first, because the interesting end of history
 * is the end nearest now.
 */
export function orderGlobalAgentRows(
  rows: ReadonlyArray<GlobalAgentRow>,
): ReadonlyArray<GlobalAgentRow> {
  const live: GlobalAgentRow[] = [];
  const settled: GlobalAgentRow[] = [];
  for (const row of rows) {
    if (row.agent.completedAt === null && row.agent.status !== "completed") live.push(row);
    else settled.push(row);
  }
  live.sort(
    (left, right) =>
      startedKey(left.agent) - startedKey(right.agent) || left.id.localeCompare(right.id),
  );
  settled.sort(
    (left, right) =>
      finishedKey(right.agent) - finishedKey(left.agent) || left.id.localeCompare(right.id),
  );
  return [...live, ...settled];
}

export function buildGlobalAgentRows(input: GlobalAgentsBoardInput): ReadonlyArray<GlobalAgentRow> {
  const projectTitles = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const threadTitles = new Map(
    input.threads.map((thread) => [
      `${thread.environmentId}:${thread.source.id}`,
      thread.source.title,
    ]),
  );

  const rows: GlobalAgentRow[] = [];
  for (const thread of input.threads) {
    const shell = thread.source;
    if (shell.lineage.relationshipToParent !== "subagent") continue;
    const parentThreadId = shell.lineage.parentThreadId;
    rows.push({
      id: `${thread.environmentId}:${shell.id}`,
      threadId: shell.id,
      environmentId: thread.environmentId,
      projectId: shell.projectId,
      projectTitle: projectTitles.get(`${thread.environmentId}:${shell.projectId}`) ?? null,
      parentThreadId,
      parentThreadTitle:
        parentThreadId === null
          ? null
          : (threadTitles.get(`${thread.environmentId}:${parentThreadId}`) ?? null),
      agent: runtimeSubagentFromThread(shell),
    });
  }
  return orderGlobalAgentRows(rows);
}

/** Environments represented in a row set, in first-seen order. */
export function globalAgentEnvironmentIds(
  rows: ReadonlyArray<GlobalAgentRow>,
): ReadonlyArray<EnvironmentId> {
  const seen: EnvironmentId[] = [];
  for (const row of rows) {
    if (!seen.includes(row.environmentId)) seen.push(row.environmentId);
  }
  return seen;
}

/**
 * The board can span many projects, so the header narrows it to one. A filter
 * value is `environmentId:projectId` because a project id is only unique
 * within its environment; an empty selection reads as every project.
 */
export function globalAgentProjectKey(row: GlobalAgentRow): string {
  return `${row.environmentId}:${row.projectId}`;
}

export function filterGlobalAgentRows(
  rows: ReadonlyArray<GlobalAgentRow>,
  selected: string | null,
): ReadonlyArray<GlobalAgentRow> {
  if (selected === null || selected === "") return rows;
  return rows.filter((row) => globalAgentProjectKey(row) === selected);
}

export type GlobalAgentsBoardColumn = AgentsBoardColumn<GlobalAgentRow>;

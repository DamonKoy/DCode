/**
 * The Agents board: every subagent this thread ever handed work to, in lanes,
 * so work in flight, work blocked on the user and finished work are legible at
 * a glance without leaving the thread.
 *
 * Rows come from the thread projection plus the child threads the shell
 * snapshot already carries, so the board needs no request of its own. Live
 * elapsed time ticks through `AgentElapsed`'s DOM writes rather than React
 * commits — a board that repaints once a second would cost every open panel.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type { OrchestrationV2ThreadShell, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { useServerConfigs, useThreadProjection, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SubagentAvatar } from "../chat/V2LifecycleRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AGENTS_BOARD_STATUS_LABELS,
  agentsBoardColumnForStatus,
  buildAgentsBoardRows,
  groupAgentsBoardRows,
  summarizeAgentsBoard,
  type AgentsBoardColumnId,
  type AgentsBoardRow,
} from "./agentsBoard.logic.ts";

const LANE_DOT_CLASS: Readonly<Record<AgentsBoardColumnId, string>> = {
  working: "bg-info",
  waiting: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
};

/** One line of detail: progress while it runs, then the result or the error. */
function detailText(row: AgentsBoardRow): string | null {
  const agent = row.agent;
  if (isOrchestrationV2WorkActive(agent.status)) return agent.progress;
  return agent.error ?? agent.result;
}

export function AgentsBoard({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const threadShells = useThreadShells();
  const providers = useServerConfigs().get(threadRef.environmentId)?.providers;
  const navigate = useNavigate();

  // A subagent child is a real thread; the shell snapshot is where its own run
  // status lives, which is what a settled task cannot report.
  const childThreads = useMemo(() => {
    const byId = new Map<string, OrchestrationV2ThreadShell>();
    for (const shell of threadShells) {
      if (shell.environmentId !== threadRef.environmentId) continue;
      const thread = shell.source;
      if (thread.lineage.relationshipToParent !== "subagent") continue;
      if (thread.lineage.parentThreadId !== threadRef.threadId) continue;
      byId.set(thread.id, thread);
    }
    return byId;
  }, [threadRef.environmentId, threadRef.threadId, threadShells]);

  const rows = useMemo(
    () => buildAgentsBoardRows({ subagents: projection?.subagents ?? [], childThreads }),
    [childThreads, projection?.subagents],
  );
  const columns = useMemo(() => groupAgentsBoardRows(rows), [rows]);
  const summary = summarizeAgentsBoard(rows);

  const openThread = (threadId: string) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId as ThreadId)),
    });
  };

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="max-w-xs text-center text-sm text-muted-foreground">
          <BotIcon aria-hidden className="mx-auto mb-2 size-5 opacity-60" />
          No agents yet. Work this thread delegates, and the subagents its provider spawns, show up
          here while they run.
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agents-board>
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
        data-agents-board-summary
      >
        <span>{summary.total} agents</span>
        {summary.working > 0 ? <span>· {summary.working} working</span> : null}
        {summary.waiting > 0 ? <span>· {summary.waiting} waiting on you</span> : null}
        {summary.failed > 0 ? (
          <span className="text-destructive">· {summary.failed} failed</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {columns.map((column) =>
          column.rows.length === 0 ? null : (
            <section key={column.id} className="mb-3 last:mb-0" data-agents-board-lane={column.id}>
              <h4 className="flex items-center gap-1.5 px-1 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", LANE_DOT_CLASS[column.id])}
                />
                {column.label}
                <span className="tabular-nums">({column.rows.length})</span>
              </h4>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {column.rows.map((row) => {
                  const provider = providers?.find(
                    (entry) => entry.instanceId === row.providerInstanceId,
                  );
                  const detail = detailText(row);
                  const title =
                    row.agent.title.trim().length === 0
                      ? "Subagent"
                      : formatSubagentDisplayTitle(row.agent.title);
                  const card = (
                    <button
                      type="button"
                      disabled={row.childThreadId === null}
                      onClick={() => {
                        if (row.childThreadId !== null) openThread(row.childThreadId);
                      }}
                      className={cn(
                        "group flex w-full flex-col gap-1 rounded-lg border border-border/60 bg-card px-2 py-1.5 text-left",
                        row.childThreadId === null
                          ? "cursor-default"
                          : "cursor-pointer hover:border-border hover:bg-accent/40",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <SubagentAvatar
                          driver={row.driver ?? undefined}
                          provider={provider}
                          className="size-5"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {title}
                        </span>
                        {row.agent.startedAt === null ? null : (
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            <AgentElapsed agent={row.agent} />
                          </span>
                        )}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                        <span className="shrink-0">
                          {AGENTS_BOARD_STATUS_LABELS[row.agent.status]}
                        </span>
                        {row.agent.model === null ? null : (
                          <>
                            <span aria-hidden>·</span>
                            <span className="min-w-0 truncate">{row.agent.model}</span>
                          </>
                        )}
                      </span>
                      {detail === null || detail.trim().length === 0 ? null : (
                        <span
                          className={cn(
                            "line-clamp-2 text-2xs",
                            agentsBoardColumnForStatus(row.agent.status) === "failed"
                              ? "text-destructive/90"
                              : "text-muted-foreground/80",
                          )}
                        >
                          {detail.trim()}
                        </span>
                      )}
                    </button>
                  );
                  return (
                    <li key={row.id}>
                      <Tooltip>
                        <TooltipTrigger render={card} />
                        <TooltipPopup side="left">
                          {row.childThreadId === null
                            ? "No thread of its own yet"
                            : "Open this agent's thread"}
                        </TooltipPopup>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The thread's Agents board: every subagent this conversation ever handed work
 * to, in lanes, so work in flight, work blocked on the user and finished work
 * are legible at a glance without leaving the thread.
 *
 * Rows come from the thread projection plus the child threads the shell
 * snapshot already carries, so the board needs no request of its own. Live
 * elapsed time ticks through `AgentElapsed`'s DOM writes rather than React
 * commits — a board that repaints once a second would cost every open panel.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useServerConfigs, useThreadProjection, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useI18n } from "../../hooks/useI18n";
import { AgentCard } from "./AgentCard";
import { AgentLane } from "./AgentLane";
import { AgentTaskDetail } from "./AgentTaskDetail";
import {
  AGENTS_BOARD_COLUMN_LABEL_KEYS,
  buildAgentsBoardRows,
  groupAgentsBoardRows,
  summarizeAgentsBoard,
} from "./agentsBoard.logic.ts";

export function AgentsBoard({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { t } = useI18n();
  const projection = useThreadProjection(threadRef)?.projection ?? null;
  const threadShells = useThreadShells();
  const providers = useServerConfigs().get(threadRef.environmentId)?.providers;
  const navigate = useNavigate();

  // A subagent child is a real thread; the shell snapshot is where its own run
  // status lives, which is what a settled task cannot report.
  const childThreads = useMemo(() => {
    const byId = new Map<string, (typeof threadShells)[number]["source"]>();
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

  // Selecting a row opens its output in this panel instead of navigating. The
  // board stays mounted underneath, so going back loses no context.
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

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
          {t("agents.board.empty")}
        </div>
      </div>
    );
  }

  if (selectedRow !== null) {
    const childThreadId = selectedRow.childThreadId;
    return (
      <AgentTaskDetail
        // Remount per row so follow mode and scroll reset between agents.
        key={selectedRow.id}
        threadRef={threadRef}
        agent={selectedRow.agent}
        driver={selectedRow.driver ?? undefined}
        provider={providers?.find((entry) => entry.instanceId === selectedRow.providerInstanceId)}
        childThreadId={childThreadId}
        onBack={() => setSelectedRowId(null)}
        onOpenThread={childThreadId === null ? null : () => openThread(childThreadId)}
        onOpenThreadId={(threadId) => openThread(threadId)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agents-board>
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground"
        data-agents-board-summary
      >
        <span>{t("agents.board.total", { count: summary.total })}</span>
        {summary.working > 0 ? (
          <span>· {t("agents.board.working", { count: summary.working })}</span>
        ) : null}
        {summary.waiting > 0 ? (
          <span>· {t("agents.board.waiting", { count: summary.waiting })}</span>
        ) : null}
        {summary.failed > 0 ? (
          <span className="text-destructive">
            · {t("agents.board.failed", { count: summary.failed })}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {columns.map((column) =>
          column.rows.length === 0 ? null : (
            <AgentLane
              key={column.id}
              id={column.id}
              label={t(AGENTS_BOARD_COLUMN_LABEL_KEYS[column.id])}
              count={column.rows.length}
            >
              {column.rows.map((row) => (
                <li key={row.id}>
                  <AgentCard
                    agent={row.agent}
                    driver={row.driver ?? undefined}
                    provider={providers?.find(
                      (entry) => entry.instanceId === row.providerInstanceId,
                    )}
                    onOpen={null}
                    onSelect={() => setSelectedRowId(row.id)}
                    selected={row.id === selectedRowId}
                  />
                </li>
              ))}
            </AgentLane>
          ),
        )}
      </div>
    </div>
  );
}

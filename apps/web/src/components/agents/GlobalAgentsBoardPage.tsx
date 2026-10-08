/**
 * The environment board: every subagent thread across every connected server in
 * one kanban, so a reader running several projects does not have to visit each
 * conversation to find out what is still working or what is waiting on them.
 *
 * It reads the shell snapshot the client already holds, so it opens instantly
 * and stays live without polling.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { isElectron } from "../../env";
import { useI18n } from "../../hooks/useI18n";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AgentCard } from "./AgentCard";
import { AgentLane } from "./AgentLane";
import {
  buildGlobalAgentRows,
  filterGlobalAgentRows,
  globalAgentEnvironmentIds,
  globalAgentProjectKey,
  type GlobalAgentRow,
} from "./globalAgentsBoard.logic.ts";
import {
  AGENTS_BOARD_COLUMN_LABEL_KEYS,
  groupAgentsBoardRows,
  summarizeAgentsBoard,
  type AgentsBoardColumnId,
} from "./agentsBoard.logic.ts";

/** A lane is capped so a long history cannot bury the work in flight. */
const LANE_INITIAL_COUNT = 8;
const LANE_PAGE_COUNT = 16;

export function GlobalAgentsBoardPage() {
  const { t } = useI18n();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const navigate = useNavigate();
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [laneLimits, setLaneLimits] = useState<Partial<Record<AgentsBoardColumnId, number>>>({});

  const allRows = useMemo(() => buildGlobalAgentRows({ threads, projects }), [projects, threads]);
  const rows = useMemo(
    () => filterGlobalAgentRows(allRows, projectFilter),
    [allRows, projectFilter],
  );
  const columns = useMemo(() => groupAgentsBoardRows(rows), [rows]);
  const summary = summarizeAgentsBoard(rows);
  const environmentIds = globalAgentEnvironmentIds(rows);
  const multiEnvironment = environmentIds.length > 1;

  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const contextFor = (row: GlobalAgentRow): string[] => [
    row.projectTitle ?? t("agents.page.unknownProject"),
    ...(row.parentThreadTitle === null ? [] : [row.parentThreadTitle]),
    ...(multiEnvironment ? [serverConfigs.get(row.environmentId)?.environment.label ?? ""] : []),
  ];

  /** One option per environment-scoped project, in the row set's first-seen order. */
  const projectOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of allRows) {
      const key = globalAgentProjectKey(row);
      if (!seen.has(key)) {
        seen.set(key, row.projectTitle ?? t("agents.page.unknownProject"));
      }
    }
    return [...seen.entries()];
  }, [allRows, t]);
  const filterVisible = projectOptions.length > 1;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={t("agents.title")}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{t("agents.title")}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <div className="min-w-0 flex-1" />
        {filterVisible ? (
          <Select
            value={projectFilter ?? ""}
            onValueChange={(value) => {
              setProjectFilter(value === "" ? null : value);
              setLaneLimits({});
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-44 shrink-0"
              aria-label={t("agents.page.filter.label")}
            >
              <SelectValue>
                {projectFilter === null
                  ? t("agents.page.filter.all")
                  : (projectOptions.find(([key]) => key === projectFilter)?.[1] ??
                    t("agents.page.filter.all"))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="">
                {t("agents.page.filter.all")}
              </SelectItem>
              {projectOptions.map(([key, label]) => (
                <SelectItem key={key} hideIndicator value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground" data-agents-page-summary>
          {summary.total === 0
            ? t("agents.page.idle")
            : [
                t("agents.board.working", { count: summary.working }),
                ...(summary.waiting > 0
                  ? [t("agents.board.waiting", { count: summary.waiting })]
                  : []),
                ...(summary.failed > 0
                  ? [t("agents.board.failed", { count: summary.failed })]
                  : []),
              ].join(" · ")}
        </span>
      </WorkspacePageHeader>

      {!bootstrapped ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
          {t("agents.page.loading")}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-sm text-center text-sm text-muted-foreground">
            <BotIcon aria-hidden className="mx-auto mb-2 size-5 opacity-60" />
            {t("agents.page.empty")}
          </div>
        </div>
      ) : (
        <div
          className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3"
          data-agents-board
        >
          <div className="grid grid-cols-1 gap-x-4 md:grid-cols-2 xl:grid-cols-4">
            {columns.map((column) => {
              if (column.rows.length === 0) return null;
              const limit = laneLimits[column.id] ?? LANE_INITIAL_COUNT;
              const visible = column.rows.slice(0, limit);
              const hidden = column.rows.length - visible.length;
              return (
                <AgentLane
                  key={column.id}
                  id={column.id}
                  label={t(AGENTS_BOARD_COLUMN_LABEL_KEYS[column.id])}
                  count={column.rows.length}
                >
                  {visible.map((row) => (
                    <li key={row.id}>
                      <AgentCard
                        agent={row.agent}
                        context={contextFor(row)}
                        onOpen={() => openThread(row.environmentId, row.threadId)}
                      />
                    </li>
                  ))}
                  {hidden > 0 ? (
                    <li>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() =>
                          setLaneLimits((current) => ({
                            ...current,
                            [column.id]: limit + LANE_PAGE_COUNT,
                          }))
                        }
                      >
                        {t("agents.page.showMore", { count: Math.min(hidden, LANE_PAGE_COUNT) })}
                      </Button>
                    </li>
                  ) : null}
                </AgentLane>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

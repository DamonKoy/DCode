/**
 * One selected subagent's output, rendered inside the agents board so a reader
 * can watch a delegated task without leaving the conversation.
 *
 * The panel mounts the child thread's state atom only for the row that is open.
 * That atom is the same live `subscribeThread` stream the chat view uses, with
 * an idle TTL of zero, so opening a row subscribes to exactly one child thread
 * and closing it drops the subscription. No agent-side result reading happens
 * here: rendering the client projection of the child thread never acknowledges
 * a delegated completion or consumes the parent agent's notification.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { shouldShowLoadEarlierControl } from "@t3tools/client-runtime/state/threads";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ProviderDriverKind, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowLeftIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "../../hooks/useI18n";
import { cn } from "../../lib/utils";
import {
  useThreadHistory,
  useThreadProjection,
  useThreadStatus,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SubagentAvatar } from "../chat/V2LifecycleRow";
import { Button } from "../ui/button";
import { AgentTaskDetailItem } from "./AgentTaskDetailItem";
import {
  AGENTS_BOARD_STATUS_LABEL_KEYS,
  AGENT_DETAIL_CONNECTION_LABEL_KEYS,
  agentsBoardColumnForStatus,
  isScrolledToLatest,
  resolveAgentDetailConnectionState,
} from "./agentsBoard.logic.ts";

const STATUS_TONE_CLASS: Readonly<Record<"working" | "waiting" | "done" | "failed", string>> = {
  working: "text-info",
  waiting: "text-warning",
  done: "text-success",
  failed: "text-destructive",
};

function SummaryBlock(props: {
  readonly label: string;
  readonly text: string | null;
  readonly tone?: "default" | "danger";
}) {
  if (props.text === null || props.text.trim().length === 0) return null;
  return (
    <div className="space-y-1" data-agent-detail-summary={props.label}>
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      <p
        className={cn(
          "whitespace-pre-wrap break-words text-xs",
          props.tone === "danger" ? "text-destructive" : "text-foreground/90",
        )}
      >
        {props.text.trim()}
      </p>
    </div>
  );
}

export function AgentTaskDetail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly agent: RuntimeSubagent;
  readonly driver?: ProviderDriverKind | undefined;
  readonly provider?: Parameters<typeof SubagentAvatar>[0]["provider"];
  /** The child conversation backing this row, or null for a native subagent. */
  readonly childThreadId: string | null;
  readonly onBack: () => void;
  readonly onOpenThread: (() => void) | null;
  readonly onOpenThreadId: (threadId: ThreadId) => void;
}) {
  const { t } = useI18n();
  const { agent } = props;
  const childRef =
    props.childThreadId === null
      ? null
      : scopeThreadRef(props.threadRef.environmentId, props.childThreadId as ThreadId);

  // Only the selected row's child thread is mounted here, so this panel holds
  // one live subscription at a time.
  const projection = useThreadProjection(childRef)?.projection ?? null;
  const items = useThreadVisibleTurnItems(childRef);
  const connection = resolveAgentDetailConnectionState(useThreadStatus(childRef));
  const history = useThreadHistory(childRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier agent output",
    reportFailure: false,
  });

  const cwd = projection?.thread.worktreePath ?? undefined;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  // The newest row doubles as this panel's content version: streaming text
  // rebuilds the projection, so the last item's identity changes as output
  // grows. Depending on it (and not the whole array) is what re-runs the
  // follow scroll only when there is new output to reveal.
  const lastItem = items.length === 0 ? null : items[items.length - 1]!;

  // Scrolling up turns follow off; the button below turns it back on. The
  // effect only runs when output grows, so nothing repaints between frames.
  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    setFollowing(
      isScrolledToLatest({
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!following || lastItem === null) return;
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [following, lastItem]);

  const title =
    agent.title.trim().length === 0
      ? t("agents.card.defaultTitle")
      : formatSubagentDisplayTitle(agent.title);
  const column = agentsBoardColumnForStatus(agent.status);

  const showLoadEarlier = childRef !== null && shouldShowLoadEarlierControl(history);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agent-detail>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("agents.detail.back")}
          onClick={props.onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <SubagentAvatar driver={props.driver} provider={props.provider} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{title}</span>
        {agent.startedAt === null ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">
            <AgentElapsed agent={agent} />
          </span>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/45 px-2 py-1 text-2xs">
        <span
          className={cn("font-medium", STATUS_TONE_CLASS[column])}
          data-agent-detail-task-status={agent.status}
        >
          {t(AGENTS_BOARD_STATUS_LABEL_KEYS[agent.status])}
        </span>
        {agent.model === null ? null : (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span className="min-w-0 truncate text-muted-foreground">{agent.model}</span>
          </>
        )}
        {childRef === null ? null : (
          <>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span
              className={cn(
                "rounded-full border px-1.5 py-0.5",
                connection === "interrupted" || connection === "gone"
                  ? "border-destructive/40 text-destructive"
                  : "border-border/60 text-muted-foreground",
              )}
              data-agent-detail-connection={connection}
            >
              {t(AGENT_DETAIL_CONNECTION_LABEL_KEYS[connection])}
            </span>
          </>
        )}
        <span className="min-w-0 flex-1" />
        {props.onOpenThread === null ? null : (
          <Button variant="ghost" size="sm" onClick={props.onOpenThread}>
            <ExternalLinkIcon className="size-3" />
            {t("agents.detail.openThread")}
          </Button>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2"
          data-agent-detail-scroll
        >
          {showLoadEarlier && childRef !== null ? (
            <div className="mb-2 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                disabled={history.loading}
                onClick={() => {
                  void loadEarlier({
                    environmentId: childRef.environmentId,
                    input: { threadId: childRef.threadId },
                  });
                }}
              >
                {history.loading
                  ? t("agents.detail.loadEarlierLoading")
                  : t("agents.detail.loadEarlier")}
              </Button>
            </div>
          ) : null}

          {childRef === null ? (
            <div className="space-y-3" data-agent-detail-summary-only>
              <p className="rounded-md border border-border/50 bg-muted/20 p-2 text-2xs text-muted-foreground">
                {t("agents.detail.summaryOnly")}
              </p>
              <SummaryBlock label={t("agents.detail.progressLabel")} text={agent.progress} />
              <SummaryBlock
                label={
                  agent.error === null
                    ? t("agents.detail.resultLabel")
                    : t("agents.detail.errorLabel")
                }
                text={agent.error ?? agent.result}
                tone={agent.error === null ? "default" : "danger"}
              />
            </div>
          ) : items.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              {connection === "connecting" || connection === "pending"
                ? t("agents.detail.loading")
                : t("agents.detail.empty")}
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {items.map((item) => (
                <li key={`${item.sourceThreadId}:${item.position}:${item.sourceItemId}`}>
                  <AgentTaskDetailItem
                    item={item}
                    environmentId={props.threadRef.environmentId}
                    cwd={cwd}
                    onOpenThreadId={props.onOpenThreadId}
                    onOpenDiff={props.onOpenThread}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        {following ? null : (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              className="pointer-events-auto"
              onClick={() => setFollowing(true)}
            >
              <ArrowDownIcon className="size-3" />
              {t("agents.detail.follow")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

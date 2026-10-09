/**
 * One subagent as a board card. Shared by the thread board and the environment
 * board so a card keeps the same shape wherever a reader meets it: the thread
 * board only adds nothing to it, while the environment board names the project
 * and parent conversation the agent belongs to.
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { useI18n } from "../../hooks/useI18n";
import { AgentElapsed } from "../chat/AgentElapsed";
import { SubagentAvatar } from "../chat/V2LifecycleRow";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AGENTS_BOARD_STATUS_LABEL_KEYS, agentsBoardColumnForStatus } from "./agentsBoard.logic.ts";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";

/** One line of detail: progress while it runs, then the result or the error. */
export function agentCardDetail(agent: RuntimeSubagent): string | null {
  if (isOrchestrationV2WorkActive(agent.status)) return agent.progress;
  return agent.error ?? agent.result;
}

export function AgentCard(props: {
  readonly agent: RuntimeSubagent;
  readonly driver?: ProviderDriverKind | undefined;
  readonly provider?: Parameters<typeof SubagentAvatar>[0]["provider"];
  /** Where the agent lives, for a board that spans threads. */
  readonly context?: ReadonlyArray<string>;
  /** Null while the agent has no thread to open. */
  readonly onOpen: (() => void) | null;
  /**
   * When provided, clicking selects the card for a same-page detail view
   * instead of navigating to the agent's thread.
   */
  readonly onSelect?: (() => void) | undefined;
  readonly selected?: boolean | undefined;
}) {
  const { t } = useI18n();
  const { agent } = props;
  const detail = agentCardDetail(agent);
  const title =
    agent.title.trim().length === 0
      ? t("agents.card.defaultTitle")
      : formatSubagentDisplayTitle(agent.title);
  const context = (props.context ?? []).filter((part) => part.trim().length > 0);
  const onClick = props.onSelect ?? props.onOpen;
  const interactive = onClick !== null;

  const card = (
    <button
      type="button"
      disabled={!interactive}
      aria-pressed={props.onSelect === undefined ? undefined : props.selected === true}
      onClick={onClick ?? undefined}
      className={cn(
        "group flex w-full flex-col gap-1 rounded-lg border border-border/60 bg-card px-2 py-1.5 text-left",
        !interactive ? "cursor-default" : "cursor-pointer hover:border-border hover:bg-accent/40",
        props.selected === true && "border-border bg-accent/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <SubagentAvatar driver={props.driver} provider={props.provider} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{title}</span>
        {agent.startedAt === null ? null : (
          <span className="shrink-0 text-2xs text-muted-foreground">
            <AgentElapsed agent={agent} />
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="shrink-0">{t(AGENTS_BOARD_STATUS_LABEL_KEYS[agent.status])}</span>
        {agent.model === null ? null : (
          <>
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate">{agent.model}</span>
          </>
        )}
      </span>
      {context.length === 0 ? null : (
        <span className="truncate text-2xs text-muted-foreground/70">{context.join(" · ")}</span>
      )}
      {detail === null || detail.trim().length === 0 ? null : (
        <span
          className={cn(
            "line-clamp-2 text-2xs",
            agentsBoardColumnForStatus(agent.status) === "failed"
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
    <Tooltip>
      <TooltipTrigger render={card} />
      <TooltipPopup side="left">
        {props.onSelect !== undefined
          ? t("agents.card.viewOutput")
          : props.onOpen === null
            ? t("agents.card.noThread")
            : t("agents.card.openThread")}
      </TooltipPopup>
    </Tooltip>
  );
}

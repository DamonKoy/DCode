/**
 * One projected item of a selected subagent's output. Assistant text and
 * progress read inline; tool calls and execution output fold behind a
 * disclosure that opens into the shared item inspector, so a reader can skim
 * the answer and expand the mechanics only when they want them.
 *
 * The inspector mounts only while its disclosure is open: a withheld tool
 * output is fetched on demand rather than for every collapsed row.
 */
import { turnItemHasDetail } from "@t3tools/client-runtime/work-log/item-detail";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, WrenchIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { V2ItemInspector } from "../chat/V2ItemInspector";
import { agentDetailItemKind } from "./agentsBoard.logic.ts";

function detailTitle(item: OrchestrationV2ProjectedTurnItem["item"]): string {
  const title = item.title?.trim();
  return title && title.length > 0 ? title : item.type.replaceAll("_", " ");
}

export const AgentTaskDetailItem = memo(function AgentTaskDetailItem(props: {
  readonly item: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
  readonly onOpenThreadId: (threadId: ThreadId) => void;
  readonly onOpenDiff: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const item = props.item.item;
  const threadRef = {
    environmentId: props.environmentId,
    threadId: props.item.sourceThreadId,
  };

  if (agentDetailItemKind(item.type) === "tool") {
    if (!turnItemHasDetail(item)) return null;
    return (
      <div
        className="rounded-md border border-border/45 bg-card/40"
        data-agent-detail-tool={item.type}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-2xs text-muted-foreground"
        >
          <WrenchIcon className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate text-foreground/80">{detailTitle(item)}</span>
          {item.status === "completed" || item.status === "idle" ? null : (
            <span className="shrink-0 rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs">
              {item.status}
            </span>
          )}
          <ChevronDownIcon
            className={cn("size-3 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
          />
        </button>
        {open ? (
          <div className="border-t border-border/45 px-2 py-1.5">
            <V2ItemInspector
              projectedItem={props.item}
              environmentId={props.environmentId}
              cwd={props.cwd}
              onOpenThread={props.onOpenThreadId}
              onOpenTurnDiff={props.onOpenDiff ?? (() => {})}
            />
          </div>
        ) : null}
      </div>
    );
  }

  switch (item.type) {
    case "assistant_message":
      if (item.text.trim().length === 0) return null;
      return (
        <div className="px-1 text-xs" data-agent-detail-text={item.type}>
          <ChatMarkdown text={item.text} cwd={props.cwd} threadRef={threadRef} />
        </div>
      );
    case "reasoning":
      if (item.text.trim().length === 0) return null;
      return (
        <div
          className="rounded-md border border-border/45 bg-muted/15 p-2 text-xs italic text-muted-foreground"
          data-agent-detail-text={item.type}
        >
          <ChatMarkdown text={item.text} cwd={props.cwd} threadRef={threadRef} lineBreaks />
        </div>
      );
    case "user_message":
      if (item.text.trim().length === 0) return null;
      return (
        <div
          className="rounded-md border border-border/50 bg-muted/20 p-2 text-xs text-foreground/85"
          data-agent-detail-text={item.type}
        >
          <ChatMarkdown text={item.text} cwd={props.cwd} threadRef={threadRef} lineBreaks />
        </div>
      );
    case "proposed_plan":
      if (item.markdown.trim().length === 0) return null;
      return (
        <div
          className="rounded-md border border-border/50 p-2 text-xs"
          data-agent-detail-text={item.type}
        >
          <ChatMarkdown text={item.markdown} cwd={props.cwd} threadRef={threadRef} />
        </div>
      );
    case "error":
      if (item.failure.message.trim().length === 0) return null;
      return (
        <p
          className="whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs text-destructive"
          data-agent-detail-text={item.type}
        >
          {item.failure.message}
        </p>
      );
    case "notification":
      if ((item.detail ?? "").trim().length === 0) return null;
      return (
        <p
          className="whitespace-pre-wrap break-words px-1 text-2xs text-muted-foreground"
          data-agent-detail-text={item.type}
        >
          {item.detail}
        </p>
      );
    case "system_notice":
      if (item.message.trim().length === 0) return null;
      return (
        <p
          className="whitespace-pre-wrap break-words px-1 text-2xs text-muted-foreground"
          data-agent-detail-text={item.type}
        >
          {item.message}
        </p>
      );
    case "todo_list":
      if (item.steps.length === 0) return null;
      return (
        <pre
          className="m-0 whitespace-pre-wrap break-words px-1 font-sans text-2xs text-muted-foreground"
          data-agent-detail-text={item.type}
        >
          {item.steps
            .map((step) => `${step.status === "completed" ? "✓" : "○"} ${step.text}`)
            .join("\n")}
        </pre>
      );
    default: {
      const label = item.title?.trim();
      if (!label) return null;
      return (
        <p className="px-1 text-2xs text-muted-foreground" data-agent-detail-text={item.type}>
          {label}
        </p>
      );
    }
  }
});

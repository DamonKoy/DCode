/**
 * One lane of an agents board: a status dot, the lane's label, how many rows it
 * holds, and the rows themselves. Both boards render lanes the same way, and
 * the lane is the only place the column colours live.
 */
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { AgentsBoardColumnId } from "./agentsBoard.logic.ts";

const LANE_DOT_CLASS: Readonly<Record<AgentsBoardColumnId, string>> = {
  working: "bg-info",
  waiting: "bg-warning",
  done: "bg-success",
  failed: "bg-destructive",
};

export function AgentLane(props: {
  readonly id: AgentsBoardColumnId;
  readonly label: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="mb-3 last:mb-0" data-agents-board-lane={props.id}>
      <h4 className="flex items-center gap-1.5 px-1 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 rounded-full", LANE_DOT_CLASS[props.id])} />
        {props.label}
        <span className="tabular-nums">({props.count})</span>
      </h4>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">{props.children}</ul>
    </section>
  );
}

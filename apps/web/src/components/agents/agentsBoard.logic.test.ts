import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent, OrchestrationV2ThreadShell } from "@t3tools/contracts";

import {
  agentDetailItemKind,
  agentsBoardColumnForStatus,
  buildAgentsBoardRows,
  groupAgentsBoardRows,
  isScrolledToLatest,
  resolveAgentDetailConnectionState,
  summarizeAgentsBoard,
} from "./agentsBoard.logic.ts";

const iso = (value: string) => DateTime.makeUnsafe(value);

/** Plain ids on purpose: the board only reads and compares them. */
function subagent(overrides: Record<string, unknown> = {}): OrchestrationV2Subagent {
  return {
    id: "subagent-1",
    threadId: "parent-thread",
    runId: "run-1",
    parentNodeId: "node-1",
    origin: "app_owned",
    driver: "acpRegistry",
    providerInstanceId: "workbuddy",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "Check the logs",
    title: "Explore logs",
    model: "deepseek-flash",
    status: "running",
    result: null,
    startedAt: iso("2026-10-07T10:00:00.000Z"),
    completedAt: null,
    updatedAt: iso("2026-10-07T10:00:05.000Z"),
    ...overrides,
  } as unknown as OrchestrationV2Subagent;
}

function childThread(
  overrides: Record<string, unknown> & { id: string },
): OrchestrationV2ThreadShell {
  return {
    projectId: "project-1",
    title: "Explore logs",
    providerInstanceId: "workbuddy",
    modelSelection: { instanceId: "workbuddy", model: "deepseek-flash" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: "parent-thread", relationshipToParent: "subagent" },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: "run-1",
    latestRunStartedAt: iso("2026-10-07T10:00:00.000Z"),
    latestRunCompletedAt: null,
    activeRunId: "run-1",
    activityRunStartedAt: iso("2026-10-07T10:00:00.000Z"),
    activityRunStatus: "running",
    status: "running",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    createdAt: iso("2026-10-07T10:00:00.000Z"),
    updatedAt: iso("2026-10-07T10:00:05.000Z"),
    archivedAt: null,
    settledAt: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
}

describe("agentsBoardColumnForStatus", () => {
  it("keeps work in flight, blocked work and settled work apart", () => {
    expect(agentsBoardColumnForStatus("pending")).toBe("working");
    expect(agentsBoardColumnForStatus("running")).toBe("working");
    expect(agentsBoardColumnForStatus("waiting")).toBe("waiting");
    expect(agentsBoardColumnForStatus("completed")).toBe("done");
    expect(agentsBoardColumnForStatus("failed")).toBe("failed");
    expect(agentsBoardColumnForStatus("cancelled")).toBe("failed");
    expect(agentsBoardColumnForStatus("interrupted")).toBe("failed");
  });

  it("never files idle under done: an idle worker is not finished work", () => {
    expect(agentsBoardColumnForStatus("idle")).toBe("waiting");
    expect(agentsBoardColumnForStatus("idle")).not.toBe("done");
  });
});

describe("buildAgentsBoardRows", () => {
  it("orders rows by activation, oldest first", () => {
    const rows = buildAgentsBoardRows({
      subagents: [
        subagent({ id: "late", startedAt: iso("2026-10-07T10:05:00.000Z") }),
        subagent({ id: "early", startedAt: iso("2026-10-07T10:01:00.000Z") }),
      ],
      childThreads: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual(["subagent:early", "subagent:late"]);
  });

  it("follows a live child thread run instead of the settled task", () => {
    const rows = buildAgentsBoardRows({
      subagents: [
        subagent({
          id: "settled",
          status: "completed",
          childThreadId: "child-thread",
          result: "first run output",
          completedAt: iso("2026-10-07T10:00:30.000Z"),
        }),
      ],
      childThreads: new Map([
        [
          "child-thread",
          childThread({
            id: "child-thread",
            status: "running",
            activityRunStartedAt: iso("2026-10-07T10:10:00.000Z"),
          }),
        ],
      ]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.agent.status).toBe("running");
    expect(rows[0]!.agent.startedAt).toBe("2026-10-07T10:10:00.000Z");
    // The settled result belongs to the earlier run and must not resurface.
    expect(rows[0]!.agent.result).toBeNull();
  });

  it("adds child threads that have no subagent record, once", () => {
    const rows = buildAgentsBoardRows({
      subagents: [subagent({ id: "recorded", childThreadId: "child-thread" })],
      childThreads: new Map([
        ["child-thread", childThread({ id: "child-thread", title: "Recorded child" })],
        ["native-child", childThread({ id: "native-child", title: "Native child" })],
      ]),
    });

    expect(rows.map((row) => row.childThreadId).sort()).toEqual(["child-thread", "native-child"]);
    expect(rows.filter((row) => row.childThreadId === "child-thread")).toHaveLength(1);
  });
});

describe("groupAgentsBoardRows", () => {
  it("groups rows into the four columns and counts them", () => {
    const rows = buildAgentsBoardRows({
      subagents: [
        subagent({ id: "running", status: "running" }),
        subagent({ id: "waiting", status: "waiting" }),
        subagent({ id: "done", status: "completed" }),
        subagent({ id: "broken", status: "failed" }),
      ],
      childThreads: new Map(),
    });

    const columns = groupAgentsBoardRows(rows);
    expect(columns.map((column) => [column.id, column.rows.length])).toEqual([
      ["working", 1],
      ["waiting", 1],
      ["done", 1],
      ["failed", 1],
    ]);
    expect(summarizeAgentsBoard(rows)).toEqual({ total: 4, working: 1, waiting: 1, failed: 1 });
  });
});

describe("resolveAgentDetailConnectionState", () => {
  it("treats a dropped stream as interrupted, never as a stopped task", () => {
    expect(resolveAgentDetailConnectionState("cached")).toBe("interrupted");
  });

  it("maps each client thread status to its own connection state", () => {
    expect(resolveAgentDetailConnectionState("live")).toBe("live");
    expect(resolveAgentDetailConnectionState("synchronizing")).toBe("connecting");
    expect(resolveAgentDetailConnectionState("empty")).toBe("pending");
    expect(resolveAgentDetailConnectionState("deleted")).toBe("gone");
  });
});

describe("agentDetailItemKind", () => {
  it("folds tool and execution items behind a disclosure", () => {
    for (const type of [
      "command_execution",
      "dynamic_tool",
      "file_search",
      "web_search",
      "file_change",
    ]) {
      expect(agentDetailItemKind(type)).toBe("tool");
    }
  });

  it("reads assistant output and progress inline", () => {
    for (const type of [
      "assistant_message",
      "reasoning",
      "notification",
      "error",
      "user_message",
    ]) {
      expect(agentDetailItemKind(type)).toBe("text");
    }
  });
});

describe("isScrolledToLatest", () => {
  it("is true at the bottom and within the follow threshold", () => {
    expect(isScrolledToLatest({ scrollTop: 400, scrollHeight: 500, clientHeight: 100 })).toBe(true);
    expect(isScrolledToLatest({ scrollTop: 360, scrollHeight: 500, clientHeight: 100 })).toBe(true);
  });

  it("is false once the reader scrolls up past the threshold", () => {
    expect(isScrolledToLatest({ scrollTop: 300, scrollHeight: 500, clientHeight: 100 })).toBe(
      false,
    );
  });
});

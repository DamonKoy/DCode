import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import {
  buildGlobalAgentRows,
  globalAgentEnvironmentIds,
  orderGlobalAgentRows,
  type GlobalAgentRow,
  type GlobalAgentsBoardInput,
} from "./globalAgentsBoard.logic.ts";

const iso = (value: string) => DateTime.makeUnsafe(value);

type ThreadInput = GlobalAgentsBoardInput["threads"][number];

/** Plain ids on purpose: the fold only reads and compares them. */
function thread(overrides: Record<string, unknown> & { id: string }): ThreadInput {
  const environmentId = (overrides.environmentId as string | undefined) ?? "env-1";
  delete overrides.environmentId;
  return {
    environmentId,
    source: {
      projectId: "project-1",
      title: "Explore logs",
      providerInstanceId: "workbuddy",
      modelSelection: { instanceId: "workbuddy", model: "deepseek-flash" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: { parentThreadId: "parent-1", relationshipToParent: "subagent" },
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
    } as unknown as OrchestrationV2ThreadShell,
  } as unknown as ThreadInput;
}

const projects = [
  { id: "project-1", title: "DAPI", environmentId: "env-1" },
  { id: "project-2", title: "LocalPanel", environmentId: "env-1" },
] as unknown as GlobalAgentsBoardInput["projects"];

describe("buildGlobalAgentRows", () => {
  it("boards only subagent threads", () => {
    const rows = buildGlobalAgentRows({
      threads: [
        thread({ id: "agent-1" }),
        thread({
          id: "parent-1",
          lineage: { parentThreadId: null, relationshipToParent: null },
        }),
      ],
      projects,
    });

    expect(rows.map((row) => row.threadId)).toEqual(["agent-1"]);
  });

  it("keeps the same thread id from two servers apart", () => {
    const rows = buildGlobalAgentRows({
      threads: [thread({ id: "shared" }), thread({ id: "shared", environmentId: "env-2" })],
      projects,
    });

    expect(rows.map((row) => row.id)).toEqual(["env-1:shared", "env-2:shared"]);
    expect(globalAgentEnvironmentIds(rows)).toEqual(["env-1", "env-2"]);
  });

  it("names the project and the parent conversation, and admits what it cannot name", () => {
    const rows = buildGlobalAgentRows({
      threads: [thread({ id: "agent-1" }), thread({ id: "parent-1", title: "Official version" })],
      projects,
    });

    expect(rows[0]!.projectTitle).toBe("DAPI");
    expect(rows[0]!.parentThreadTitle).toBe("Official version");

    const orphan = buildGlobalAgentRows({ threads: [thread({ id: "agent-1" })], projects });
    expect(orphan[0]!.parentThreadTitle).toBeNull();
    expect(orphan[0]!.projectTitle).toBe("DAPI");
  });
});

describe("orderGlobalAgentRows", () => {
  it("puts live work first, oldest first, then settled work newest first", () => {
    const row = (id: string, status: string, started: string, completed: string | null) =>
      ({
        id,
        agent: {
          status,
          startedAt: started,
          completedAt: completed,
          updatedAt: completed ?? started,
        },
      }) as unknown as GlobalAgentRow;

    const ordered = orderGlobalAgentRows([
      row("done-old", "completed", "2026-10-07T09:00:00.000Z", "2026-10-07T09:05:00.000Z"),
      row("running-late", "running", "2026-10-07T11:00:00.000Z", null),
      row("done-new", "completed", "2026-10-07T10:00:00.000Z", "2026-10-07T10:05:00.000Z"),
      row("running-early", "pending", "2026-10-07T08:00:00.000Z", null),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "running-early",
      "running-late",
      "done-new",
      "done-old",
    ]);
  });
});

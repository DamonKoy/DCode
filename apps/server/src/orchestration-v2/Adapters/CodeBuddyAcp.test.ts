import { assert, describe, it } from "@effect/vitest";

import type { AcpToolCallState } from "../../provider/acp/AcpRuntimeModel.ts";
import { extractCodeBuddySubagentUpdate, parseCodeBuddyTaskNotification } from "./CodeBuddyAcp.ts";

/** Shapes below are taken from real WorkBuddy/CodeBuddy turn items. */
function toolCall(input: {
  readonly rawInput?: Record<string, unknown>;
  readonly rawOutput?: unknown;
  readonly content?: ReadonlyArray<unknown>;
  readonly status?: AcpToolCallState["status"];
}): AcpToolCallState {
  return {
    toolCallId: "call-1",
    title: "Tool",
    kind: "other",
    status: input.status ?? "completed",
    data: {
      ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput }),
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      ...(input.content === undefined ? {} : { content: input.content }),
    },
  };
}

const DISPATCH_OUTPUT =
  "Started general-purpose agent: 校验并同步提交 my-skills\n" +
  "agent_id: agent-c95cc9f903e342d9\n" +
  "The worker is running detached (no team). The returned agent_id is the task_id. " +
  "End this turn unless the user asked for progress.\n" +
  "[Agent ID: agent-c95cc9f903e342d9]";

describe("extractCodeBuddySubagentUpdate", () => {
  describe("Agent dispatch", () => {
    it("projects a detached worker as a running subagent", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "校验并同步提交 my-skills",
            name: "sync-commit",
            prompt: "工作目录：/Users/admin/Documents/项目代码/my-skills",
            subagent_type: "general-purpose",
            run_in_background: true,
          },
          rawOutput: { type: "text", text: DISPATCH_OUTPUT },
          status: "completed",
        }),
      );

      assert.deepEqual(update, {
        nativeTaskId: "agent-c95cc9f903e342d9",
        childSessionId: null,
        prompt: "工作目录：/Users/admin/Documents/项目代码/my-skills",
        title: "sync-commit",
        model: null,
        // The dispatch tool returns as soon as the worker is detached.
        status: "running",
        result: null,
      });
    });

    it("reads a dashed agent id and falls back to the description for a title", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "部署 DHub 到 macmini 生产机",
            prompt: "你要完成 DHub 项目在 macmini 生产机上的部署收尾。",
            subagent_type: "general-purpose",
            run_in_background: true,
          },
          rawOutput: {
            type: "text",
            text:
              "Started general-purpose agent: 部署 DHub\n" +
              "agent_id: agent-69b7d1ee-173a-442d-af63-60202cd59465\n",
          },
        }),
      );

      assert.equal(update?.nativeTaskId, "agent-69b7d1ee-173a-442d-af63-60202cd59465");
      assert.equal(update?.title, "部署 DHub 到 macmini 生产机");
      assert.equal(update?.status, "running");
    });

    it("carries a completed foreground dispatch as completed with its output", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "查找日志",
            prompt: "在 ~/logs 下找出 500 的请求",
            subagent_type: "Explore",
          },
          rawOutput: { type: "text", text: DISPATCH_OUTPUT },
          status: "completed",
        }),
      );

      assert.equal(update?.status, "completed");
      assert.equal(update?.result, DISPATCH_OUTPUT);
      assert.equal(update?.title, "查找日志");
    });

    it("reports a failed dispatch as failed", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "查找日志",
            prompt: "在 ~/logs 下找出 500 的请求",
            subagent_type: "Explore",
            run_in_background: true,
          },
          rawOutput: { type: "text", text: DISPATCH_OUTPUT },
          status: "failed",
        }),
      );

      assert.equal(update?.status, "failed");
    });

    it("stays silent until the dispatch has an agent id to be attributed to", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "查找日志",
            prompt: "在 ~/logs 下找出 500 的请求",
            subagent_type: "Explore",
            run_in_background: true,
          },
          rawOutput: { type: "text", text: "Starting agent…" },
          status: "inProgress",
        }),
      );

      assert.isUndefined(update);
    });

    it("reads the agent id out of an ACP content block array", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: {
            description: "查找日志",
            prompt: "在 ~/logs 下找出 500 的请求",
            subagent_type: "Explore",
            run_in_background: true,
          },
          content: [{ type: "content", content: { type: "text", text: DISPATCH_OUTPUT } }],
        }),
      );

      assert.equal(update?.nativeTaskId, "agent-c95cc9f903e342d9");
    });
  });

  describe("TaskOutput", () => {
    const taskOutput = (status: string, taskId = "agent-97ff4adf-5260-4012-907c-028f37a44f60") =>
      toolCall({
        rawInput: { block: false, task_id: taskId },
        rawOutput: {
          type: "text",
          text:
            `Task ID: ${taskId}\nStatus: ${status}\nDuration: 23m 30s\n` +
            `Agent Type: general-purpose\n\nPrompt:\n你是 DAPI 上游同步的前端冲突解决 worker`,
        },
      });

    it("hydrates a running worker without suppressing its tool card", () => {
      const update = extractCodeBuddySubagentUpdate(taskOutput("running"));

      assert.equal(update?.nativeTaskId, "agent-97ff4adf-5260-4012-907c-028f37a44f60");
      assert.equal(update?.status, "running");
      assert.isNull(update?.result);
      assert.isFalse(update?.suppressNormalTool);
    });

    it("carries the report on a completed poll", () => {
      const update = extractCodeBuddySubagentUpdate(taskOutput("completed"));

      assert.equal(update?.status, "completed");
      assert.match(update?.result ?? "", /Status: completed/u);
    });

    it("maps cancelled and failed polls to their terminal states", () => {
      assert.equal(extractCodeBuddySubagentUpdate(taskOutput("cancelled"))?.status, "cancelled");
      assert.equal(extractCodeBuddySubagentUpdate(taskOutput("failed"))?.status, "failed");
    });

    it("treats an unrecognized poll status as still running", () => {
      assert.equal(extractCodeBuddySubagentUpdate(taskOutput("pending"))?.status, "running");
    });

    it("ignores a task id that is not a worker", () => {
      const update = extractCodeBuddySubagentUpdate(
        toolCall({
          rawInput: { block: false, task_id: "task-1234" },
          rawOutput: { type: "text", text: "Task ID: task-1234\nStatus: running\n" },
        }),
      );

      assert.isUndefined(update);
    });
  });

  it("leaves unrelated tool calls alone", () => {
    assert.isUndefined(
      extractCodeBuddySubagentUpdate(
        toolCall({ rawInput: { command: "ls -la" }, rawOutput: { type: "text", text: "ok" } }),
      ),
    );
    assert.isUndefined(
      extractCodeBuddySubagentUpdate(toolCall({ rawInput: { prompt: "no subagent type here" } })),
    );
    assert.isUndefined(extractCodeBuddySubagentUpdate(toolCall({})));
  });
});

describe("parseCodeBuddyTaskNotification", () => {
  /** Shape CodeBuddy injects into the owning session after the root turn. */
  const notification = (status: string, taskId = "agent-81d49c8c-4a0a-4a1a-9d0e-2b1f0e5a7c31") =>
    [
      "<task-notification>",
      `<task-id>${taskId}</task-id>`,
      "<kind>agent</kind>",
      `<status>${status}</status>`,
      "<summary>Ran the migration and pushed the branch</summary>",
      "</task-notification>",
      "",
      "A worker was stopped and is no longer live. Tell the user.",
    ].join("\n");

  it("reads a finished worker out of the notification", () => {
    assert.deepEqual(parseCodeBuddyTaskNotification(notification("completed")), {
      nativeTaskId: "agent-81d49c8c-4a0a-4a1a-9d0e-2b1f0e5a7c31",
      status: "completed",
      summary: "Ran the migration and pushed the branch",
    });
  });

  it("maps cancelled and failed notifications to their terminal states", () => {
    assert.equal(parseCodeBuddyTaskNotification(notification("cancelled"))?.status, "cancelled");
    assert.equal(parseCodeBuddyTaskNotification(notification("failed"))?.status, "failed");
  });

  it("treats a missing summary as no result", () => {
    const withoutSummary = notification("completed").replace(/<summary>[\s\S]*?<\/summary>/u, "");

    assert.isNull(parseCodeBuddyTaskNotification(withoutSummary)?.summary);
  });

  it("ignores text that is not a worker notification", () => {
    // No notification wrapper at all, a non-worker task id, and a status that
    // is not terminal must all stay out of the subagent path.
    assert.isUndefined(parseCodeBuddyTaskNotification("just a normal user message"));
    assert.isUndefined(parseCodeBuddyTaskNotification(notification("completed", "task-1234")));
    assert.isUndefined(parseCodeBuddyTaskNotification(notification("running")));
    assert.isUndefined(
      parseCodeBuddyTaskNotification("<task-notification>\n<status>completed</status>\n"),
    );
  });
});

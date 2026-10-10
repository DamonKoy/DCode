import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread moves"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-move" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("moves a thread to another project and resets its branch and worktree", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:move-empty");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("move-empty-create"),
      threadId,
      projectId: ProjectId.make("project:move-from"),
      title: "Wrong project",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/wrong",
      worktreePath: "/tmp/wrong-worktree",
      createdBy: "user",
      creationSource: "web",
    });

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-empty-move"),
      threadId,
      projectId: ProjectId.make("project:move-to"),
    });

    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    assert.equal(shell.projectId, ProjectId.make("project:move-to"));
    // The old project's checkout does not exist under the new root.
    assert.equal(shell.branch, null);
    assert.equal(shell.worktreePath, null);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("moves a thread that already has messages, keeping its history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:move-nonempty");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("move-nonempty-create"),
      threadId,
      projectId: ProjectId.make("project:move-from"),
      title: "Has history",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* sql`INSERT INTO orchestration_v2_projection_messages
      (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('move-nonempty-message', ${threadId}, NULL, NULL, 'user', 0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, '{"obsolete":true}')`;

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-nonempty-move"),
      threadId,
      projectId: ProjectId.make("project:move-to"),
    });

    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    assert.equal(shell.projectId, ProjectId.make("project:move-to"));
    const messageCount = yield* projections.getMessageCount(threadId);
    assert.equal(messageCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to move a thread while a run is active", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:move-active-run");
    const now = yield* DateTime.now;
    const nowIso = DateTime.formatIso(now);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("move-active-create"),
      threadId,
      projectId: ProjectId.make("project:move-from"),
      title: "Running",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const runId = RunId.make("run:move-active");
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_thread_id, status,
        requested_at, completed_at, payload_json
      ) VALUES (
        ${runId}, ${threadId}, 1, 'codex', NULL, 'running', ${nowIso}, NULL,
        ${encodeUnknownJsonString({
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: "message:move-active",
          rootNodeId: "node:move-active",
          activeAttemptId: null,
          status: "running",
          requestedAt: nowIso,
          startedAt: nowIso,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;

    const rejected = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move-active-move"),
        threadId,
        projectId: ProjectId.make("project:move-to"),
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
    assert.include(String(rejected.cause), "active work");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to move an archived thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:move-archived");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("move-archived-create"),
      threadId,
      projectId: ProjectId.make("project:move-from"),
      title: "Archived",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("move-archived-archive"),
      threadId,
    });

    const rejected = yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("move-archived-move"),
        threadId,
        projectId: ProjectId.make("project:move-to"),
      })
      .pipe(Effect.flip);
    assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
    assert.include(String(rejected.cause), "archived");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps the thread in place when it is already in the target project", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:move-same-project");
    const projectId = ProjectId.make("project:move-same");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("move-same-create"),
      threadId,
      projectId,
      title: "Same project",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/keep",
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("move-same-move"),
      threadId,
      projectId,
    });

    const shell = yield* projections.getThreadShell(threadId);
    assert.ok(shell);
    assert.equal(shell.projectId, projectId);
    // A same-project update is not a move: the branch is untouched.
    assert.equal(shell.branch, "feature/keep");
  }).pipe(Effect.provide(layerTest)),
);

// Seeds a real orchestration projection database on disk; node:sqlite and Node
// fs are used outside the service's Effect FileSystem.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";

import { orchestrationDatabasePath, readT3ProviderTurnUsage } from "./t3ProviderTurnUsageReader.ts";

function createSchema(db: NodeSqlite.DatabaseSync): void {
  db.exec(`
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      driver TEXT,
      provider_instance_id TEXT,
      provider_session_id TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_sessions (
      provider_session_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      payload_json TEXT NOT NULL
    );
  `);
}

function seedTurn(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly id: string;
    readonly driver: string;
    readonly instanceId: string;
    readonly model: string;
    readonly completedAt: string;
    readonly payload: unknown;
  },
): void {
  const providerThreadId = `pth-${input.id}`;
  const sessionId = `ps-${input.id}`;
  db.prepare(
    `INSERT INTO orchestration_v2_projection_provider_threads
       (provider_thread_id, provider, driver, provider_instance_id, provider_session_id, payload_json)
     VALUES (?, ?, ?, ?, ?, '{}')`,
  ).run(providerThreadId, input.instanceId, input.driver, input.instanceId, sessionId);
  db.prepare(
    `INSERT INTO orchestration_v2_projection_provider_sessions
       (provider_session_id, provider, model, payload_json)
     VALUES (?, ?, ?, '{}')`,
  ).run(sessionId, input.instanceId, input.model);
  db.prepare(
    `INSERT INTO orchestration_v2_projection_provider_turns
       (provider_turn_id, thread_id, provider_thread_id, started_at, completed_at, payload_json)
     VALUES (?, 'thread-1', ?, ?, ?, ?)`,
  ).run(
    input.id,
    providerThreadId,
    input.completedAt,
    input.completedAt,
    JSON.stringify(input.payload),
  );
}

async function withDatabase(
  seed: (db: NodeSqlite.DatabaseSync) => void,
  run: (dbPath: string) => Promise<void>,
): Promise<void> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
  const dbPath = orchestrationDatabasePath(NodePath.join(dir, "userdata"));
  await NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    createSchema(db);
    seed(db);
  } finally {
    db.close();
  }
  try {
    await run(dbPath);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

describe("readT3ProviderTurnUsage", () => {
  it("maps persisted per-turn usage into records for un-scanned drivers only", async () => {
    await withDatabase(
      (db) => {
        seedTurn(db, {
          id: "turn-acp",
          driver: "acpRegistry",
          instanceId: "workbuddy",
          model: "hy4-preview",
          completedAt: "2026-08-01T10:00:00Z",
          payload: {
            turnTokenUsage: {
              usageScope: "main_agent",
              hasSubagents: false,
              usageStatus: "complete",
              inputTokens: 300,
              outputTokens: 100,
              cachedInputTokens: 80,
              cacheCreationTokens: 40,
            },
          },
        });
        seedTurn(db, {
          id: "turn-pi",
          driver: "pi",
          instanceId: "pi",
          model: "pi-model",
          completedAt: "2026-08-01T11:00:00Z",
          payload: {
            tokenUsage: {
              usedTokens: 500,
              inputTokens: 400,
              cachedInputTokens: 100,
              outputTokens: 90,
              updatedAt: "2026-08-01T11:00:00Z",
            },
          },
        });
        // A file-scanned driver must never leak into this source.
        seedTurn(db, {
          id: "turn-codex",
          driver: "codex",
          instanceId: "codex",
          model: "gpt",
          completedAt: "2026-08-01T12:00:00Z",
          payload: {
            turnTokenUsage: {
              usageScope: "main_agent",
              hasSubagents: false,
              usageStatus: "complete",
              inputTokens: 10,
              outputTokens: 10,
            },
          },
        });
        // A turn with no usage contributes nothing.
        seedTurn(db, {
          id: "turn-empty",
          driver: "acpRegistry",
          instanceId: "workbuddy",
          model: "hy4-preview",
          completedAt: "2026-08-01T13:00:00Z",
          payload: { turnTokenUsage: { usageStatus: "unavailable" } },
        });
      },
      async (dbPath) => {
        const result = await readT3ProviderTurnUsage(dbPath, 0);
        assert.isFalse(result.error);
        assert.isFalse(result.missing);

        const bySource = new Map(result.sources.map((s) => [s.dir, s]));
        assert.deepStrictEqual([...bySource.keys()].sort(), ["t3-usage:pi", "t3-usage:workbuddy"]);

        const acp = bySource.get("t3-usage:workbuddy")!;
        assert.equal(acp.provider, "acpRegistry");
        assert.lengthOf(acp.records, 1);
        const acpRecord = acp.records[0]!;
        // Input is inclusive of cache: 300 - 80 cache read - 40 cache write.
        assert.deepStrictEqual(acpRecord.totals, {
          uncachedInputTokens: 180,
          cachedInputTokens: 80,
          cacheCreationTokens: 40,
          outputTokens: 100,
          reasoningTokens: 0,
        });
        assert.equal(acpRecord.model, "hy4-preview");
        assert.isNull(acpRecord.reportedCostUsd);
        assert.equal(acpRecord.dedupeKey, "t3:turn-acp");

        const pi = bySource.get("t3-usage:pi")!;
        assert.equal(pi.provider, "pi");
        assert.deepStrictEqual(pi.records[0]!.totals, {
          uncachedInputTokens: 300,
          cachedInputTokens: 100,
          cacheCreationTokens: 0,
          outputTokens: 90,
          reasoningTokens: 0,
        });
      },
    );
  });

  it("drops turns older than the window and reports a missing database", async () => {
    await withDatabase(
      (db) => {
        seedTurn(db, {
          id: "turn-old",
          driver: "pi",
          instanceId: "pi",
          model: "pi-model",
          completedAt: "2026-07-01T00:00:00Z",
          payload: {
            turnTokenUsage: {
              usageScope: "main_agent",
              hasSubagents: false,
              usageStatus: "complete",
              inputTokens: 10,
              outputTokens: 5,
            },
          },
        });
      },
      async (dbPath) => {
        const since = Date.parse("2026-08-01T00:00:00Z");
        const result = await readT3ProviderTurnUsage(dbPath, since);
        assert.deepStrictEqual(result.sources, []);

        const missing = await readT3ProviderTurnUsage(`${dbPath}.nope`, since);
        assert.isTrue(missing.missing);
        assert.isFalse(missing.error);
      },
    );
  });
});

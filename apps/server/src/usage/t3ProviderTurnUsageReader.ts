// DCode's own orchestration projection database is the source of truth for
// providers whose native sessions the usage scan does not read. Node fs and
// node:sqlite are used directly; reading it read-only never touches the writer.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

import type { UsageRecord } from "@t3tools/provider-core/server/usage";

/**
 * Drivers whose usage is only available from DCode's persisted per-turn data,
 * never from a transcript the scan reads. File-scanned drivers are deliberately
 * absent so their usage is never counted twice.
 *
 * `acpRegistry` covers every configured ACP agent (workbuddy, devin, …): the
 * driver is the implementation kind, so all its instances share one bucket.
 */
const PERSISTED_DRIVER_PROVIDERS: ReadonlyMap<string, UsageProviderKind> = new Map([
  ["pi", "pi"],
  ["acpRegistry", "acpRegistry"],
]);

/** One driver instance's persisted usage, shaped like a transcript source. */
export interface T3UsageSource {
  readonly provider: UsageProviderKind;
  /** Synthetic, stable source path so overlapping scans merge per source. */
  readonly dir: string;
  readonly records: readonly UsageRecord[];
}

export interface T3UsageReadResult {
  readonly sources: readonly T3UsageSource[];
  readonly missing: boolean;
  readonly error: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Splits a normalized per-turn usage (`turnTokenUsage`) or a context snapshot
 * (`tokenUsage`) into the billing categories. Input totals are reported
 * inclusive of cache reads and writes; a snapshot has no cache-write field, so
 * that category stays zero rather than being guessed.
 */
function totalsFromUsage(
  usage: Record<string, unknown>,
  hasCacheCreation: boolean,
): UsageTokenTotals {
  const cachedInputTokens = count(usage["cachedInputTokens"]);
  const cacheCreationTokens = hasCacheCreation ? count(usage["cacheCreationTokens"]) : 0;
  const inputTokens = count(usage["inputTokens"]);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens: count(usage["outputTokens"]),
    reasoningTokens: count(usage["reasoningTokens"] ?? usage["reasoningOutputTokens"]),
  };
}

function totalOf(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** Builds one record from a persisted provider turn, or null when it carries no usage. */
function recordFromTurn(
  provider: UsageProviderKind,
  row: {
    readonly turnId: string;
    readonly sessionId: string;
    readonly model: string;
    readonly timestampMs: number;
    readonly payload: unknown;
  },
): UsageRecord | null {
  const payload = object(row.payload);
  const turnTokenUsage = object(payload["turnTokenUsage"]);
  const contextUsage = object(payload["tokenUsage"]);
  const hasTurnTokenUsage = Object.keys(turnTokenUsage).length > 0;
  const totals = hasTurnTokenUsage
    ? totalsFromUsage(turnTokenUsage, true)
    : totalsFromUsage(contextUsage, false);
  if (totalOf(totals) === 0) return null;
  return {
    provider,
    timestampMs: row.timestampMs,
    model: row.model,
    sessionId: row.sessionId,
    totals,
    // ACP's `usage_update.cost` is cumulative for the session, not this turn,
    // so no persisted per-turn cost is trusted here. Tokens are priced from the
    // shared rate table instead.
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: row.turnId.length === 0 ? null : `t3:${row.turnId}`,
  };
}

/**
 * Reads DCode's persisted per-turn usage for providers the transcript scan
 * cannot see. Never writes; a missing or pre-migration database reports as
 * `missing` rather than failing the scan.
 */
export async function readT3ProviderTurnUsage(
  dbPath: string,
  sinceMs: number,
): Promise<T3UsageReadResult> {
  try {
    await NodeFSP.access(dbPath);
  } catch (cause) {
    if (object(cause)["code"] === "ENOENT") return { sources: [], missing: true, error: false };
    return { sources: [], missing: false, error: true };
  }

  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
    // The running server holds the writer; a busy read should fail promptly
    // instead of stalling the scan behind it.
    database.exec("PRAGMA busy_timeout = 100");
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => text((row as { name?: unknown }).name)),
    );
    if (
      !tables.has("orchestration_v2_projection_provider_turns") ||
      !tables.has("orchestration_v2_projection_provider_threads")
    ) {
      return { sources: [], missing: true, error: false };
    }

    const byInstance = new Map<
      string,
      { provider: UsageProviderKind; dir: string; records: UsageRecord[] }
    >();
    const statement = database.prepare(
      `SELECT
         pt.provider_turn_id AS turn_id,
         pt.started_at AS started_at,
         pt.completed_at AS completed_at,
         pt.payload_json AS payload_json,
         pth.provider_thread_id AS provider_thread_id,
         pth.provider_instance_id AS instance_id,
         pth.provider_session_id AS session_id,
         ps.model AS model,
         COALESCE(pth.driver, json_extract(pth.payload_json, '$.driver')) AS driver
       FROM orchestration_v2_projection_provider_turns pt
       JOIN orchestration_v2_projection_provider_threads pth
         ON pth.provider_thread_id = pt.provider_thread_id
       LEFT JOIN orchestration_v2_projection_provider_sessions ps
         ON ps.provider_session_id = pth.provider_session_id`,
    );
    for (const raw of statement.all()) {
      const row = raw as Record<string, unknown>;
      const provider = PERSISTED_DRIVER_PROVIDERS.get(text(row["driver"]));
      if (provider === undefined) continue;
      const at = timestampMs(row["completed_at"]) ?? timestampMs(row["started_at"]);
      if (at === null || at < sinceMs) continue;
      const instanceId = text(row["instance_id"]) || text(row["provider_thread_id"]) || provider;
      let payload: unknown;
      try {
        payload = JSON.parse(text(row["payload_json"]));
      } catch {
        continue;
      }
      const record = recordFromTurn(provider, {
        turnId: text(row["turn_id"]),
        sessionId: text(row["session_id"]) || text(row["provider_thread_id"]),
        model: text(row["model"]) || provider,
        timestampMs: at,
        payload,
      });
      if (record === null) continue;
      const dir = `t3-usage:${instanceId}`;
      let entry = byInstance.get(instanceId);
      if (entry === undefined) {
        entry = { provider, dir, records: [] };
        byInstance.set(instanceId, entry);
      }
      entry.records.push(record);
    }
    return { sources: [...byInstance.values()], missing: false, error: false };
  } catch {
    return { sources: [], missing: false, error: true };
  } finally {
    database?.close();
  }
}

/** Absolute path to the orchestration state database inside a state directory. */
export function orchestrationDatabasePath(stateDir: string): string {
  return NodePath.join(stateDir, "statev2.sqlite");
}

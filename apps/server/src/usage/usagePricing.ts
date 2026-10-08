/**
 * Model rate lookup and cost arithmetic.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` prices against. Everything here is pure: fetching and caching
 * the table lives in `UsageService`.
 *
 * @module usagePricing
 */
import type {
  UsageCategoryCost,
  UsageCostSource,
  UsageModelPriceOverride,
  UsageTokenTotals,
} from "@t3tools/contracts";

import type { UsageRecord, UsageSpeed } from "./usageTranscripts.ts";

/** Token rates for one billing speed. All values are USD per token. */
export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

/**
 * The subset of a LiteLLM entry we price against: standard rates, plus rates
 * for each faster speed the model publishes. A request at a speed with no
 * published rates bills at the standard rates.
 *
 * LiteLLM also publishes `*_above_272k_tokens`, `*_flex`, and `*_batches`
 * variants. Transcripts don't record those, so we don't price them.
 */
export interface ModelRate extends TokenRates {
  /**
   * From LiteLLM's `provider_specific_entry.fast` multiple (Claude fast mode),
   * or else its `*_priority` rates (Codex `priority`).
   */
  readonly fast: TokenRates | null;
  /** From LiteLLM's `*_ultrafast` rates (Codex `ultrafast`). */
  readonly ultrafast: TokenRates | null;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/**
 * Custom IDs keep their case, provider prefix, and variant suffix. Custom rates
 * apply as entered, at every speed.
 */
export function createOverrideRateTable(
  overrides: Readonly<Record<string, UsageModelPriceOverride>>,
): RateTable {
  return new Map(
    Object.entries(overrides).map(([model, prices]) => [
      model.trim(),
      {
        inputCostPerToken: prices.inputCostPerMillionTokens / 1_000_000,
        outputCostPerToken: prices.outputCostPerMillionTokens / 1_000_000,
        cacheReadCostPerToken:
          (prices.cacheReadCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
        cacheCreationCostPerToken:
          (prices.cacheWriteCostPerMillionTokens ?? prices.inputCostPerMillionTokens) / 1_000_000,
        fast: null,
        ultrafast: null,
      },
    ]),
  );
}

/** One raw LiteLLM entry. Field names carry a tier suffix, e.g. `_priority`. */
type LiteLlmEntry = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads one rate set, `suffix` selecting a tier such as `_priority`. Returns
 * `null` without both an input and an output rate.
 *
 * Anthropic bills cache reads at a discount and cache writes at a premium.
 * When the standard tier omits them, cached input is priced as plain input
 * rather than as free. A faster tier that omits them keeps the standard tier's
 * cache-to-input ratio.
 */
function readTokenRates(
  entry: LiteLlmEntry,
  suffix: string,
  standard?: TokenRates,
): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cacheRate = (name: string, field: "cacheReadCostPerToken" | "cacheCreationCostPerToken") =>
    finiteNumber(entry[`${name}${suffix}`]) ??
    (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : input);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate(
      "cache_creation_input_token_cost",
      "cacheCreationCostPerToken",
    ),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
  };
}

/** Reads `provider_specific_entry.fast`, e.g. `2` for Claude Opus 5.5. */
function fastMultiplier(entry: LiteLlmEntry): number | null {
  const specific = entry["provider_specific_entry"];
  if (typeof specific !== "object" || specific === null) return null;
  const fast = finiteNumber((specific as Record<string, unknown>)["fast"]);
  return fast !== null && fast > 0 ? fast : null;
}

/**
 * Projects the LiteLLM document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced
 * model would silently under-report cost, which is worse than reporting the
 * model as unpriced.
 *
 * Entries keep their full normalized key; a bare name is aliased only when no
 * canonical entry exists and every qualified entry has the same rate.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const standard = readTokenRates(entry, "");
    if (standard === null) continue;

    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const multiple = fastMultiplier(entry);
    table.set(key, {
      ...standard,
      fast:
        multiple === null
          ? readTokenRates(entry, "_priority", standard)
          : scaleTokenRates(standard, multiple),
      ultrafast: readTokenRates(entry, "_ultrafast", standard),
    });
  }

  // `null` marks a bare name claimed at conflicting rates: no alias for it.
  const aliasCandidates = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const held = aliasCandidates.get(alias);
    if (held === undefined) {
      aliasCandidates.set(alias, rate);
    } else if (held !== null && !sameRate(held, rate)) {
      aliasCandidates.set(alias, null);
    }
  }
  for (const [alias, rate] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }

  return table;
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  );
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  return (
    sameTokenRates(a, b) &&
    sameTokenRates(a.fast, b.fast) &&
    sameTokenRates(a.ultrafast, b.ultrafast)
  );
}

/** The rates a request at `speed` bills at. */
function ratesAt(rate: ModelRate, speed: UsageSpeed): TokenRates {
  return (speed === "standard" ? null : rate[speed]) ?? rate;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/**
 * Drops a bracketed variant suffix such as `claude-fable-5-1[1m]`, which
 * Claude Code writes for the 1M context tier. The rate table only knows the
 * base name, and we price at the base tier anyway.
 */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/**
 * One trailing token describing how a model's weights were quantized rather
 * than which model they are: `-GPTQ`, `-Int4`, `-AWQ`, `-FP8`, `-Q4_K_M`,
 * `-IQ3_S`, or Unsloth's `-UD`. Compound tails are peeled token by token, so
 * `-UD-IQ3_S` comes off in two steps.
 *
 * Names are already lowercased before this runs.
 */
const QUANTIZATION_TOKEN =
  /^(?:ud|unsloth|dynamic|gptq|awq|gguf|ggml|exl2|mlx|bnb|bitsandbytes|nf4|fp8|fp16|bf16|fp32|int[248]|q[2-8](?:_[a-z0-9]+)*|iq[1-4](?:_[a-z0-9]+)*|[2-8]bit)$/;

function stripQuantizationSuffix(key: string): string {
  const parts = key.split("-");
  let end = parts.length;
  while (end > 1 && QUANTIZATION_TOKEN.test(parts[end - 1]!)) end--;
  return parts.slice(0, end).join("-");
}

/** A plausible `MMDD` (4), `YYMMDD` (6), or `YYYYMMDD` (8) date snapshot tag. */
function isCompactDate(token: string): boolean {
  const monthDay = (month: number, day: number) =>
    month >= 1 && month <= 12 && day >= 1 && day <= 31;
  if (/^(?:19|20)\d{6}$/.test(token)) {
    return monthDay(Number(token.slice(4, 6)), Number(token.slice(6, 8)));
  }
  if (/^\d{6}$/.test(token)) {
    return monthDay(Number(token.slice(2, 4)), Number(token.slice(4, 6)));
  }
  if (/^\d{4}$/.test(token)) {
    return monthDay(Number(token.slice(0, 2)), Number(token.slice(2, 4)));
  }
  return false;
}

/**
 * Drops a trailing snapshot date such as `deepseek-v4-flash-0731` or
 * `claude-3-5-sonnet-20241022`. Only plausible calendar values are peeled, so
 * a context or size tail like `-122b` survives.
 */
function stripDateSuffix(key: string): string {
  const hyphenated = /-(?:19|20)\d{2}-\d{2}-\d{2}$/.exec(key);
  if (hyphenated !== null) return key.slice(0, key.length - hyphenated[0].length);
  const parts = key.split("-");
  if (parts.length > 1 && isCompactDate(parts[parts.length - 1]!)) {
    return parts.slice(0, -1).join("-");
  }
  return key;
}

/** `deepseek_v3` and `deepseek-v3` are the same model, spelled differently. */
function normalizeSeparators(key: string): string {
  return key.includes("_") ? key.replaceAll("_", "-") : key;
}

/**
 * Provider path segments that name the same vendor under a different
 * spelling, mapped to the segment the rate table uses. Applied only to the
 * leading segment; the price still comes from the table entry we land on.
 * `moonshotai` is Moonshot AI's HuggingFace org name, `zai-org`/`z-ai` are
 * Z.ai's across gateways.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  moonshotai: "moonshot",
  "zai-org": "zai",
  "z-ai": "zai",
};

function aliasProviderSegment(key: string): string {
  const slash = key.indexOf("/");
  const head = slash === -1 ? key : key.slice(0, slash);
  const alias = PROVIDER_ALIASES[head];
  return alias === undefined ? key : `${alias}${key.slice(head.length)}`;
}

/**
 * Rate-table keys to try for a normalized model name, most specific first:
 * the name itself, then with a provider segment aliased, then separators
 * normalized, each also tried with its provider prefix dropped (bare name).
 * A bare name that is genuinely ambiguous never appears in the table, so it
 * simply misses and the lookup stays unpriced.
 */
function candidateKeys(base: string): readonly string[] {
  const stages = [base];
  const noQuantization = stripQuantizationSuffix(base);
  if (noQuantization !== base) stages.push(noQuantization);
  const last = stages[stages.length - 1]!;
  const noDate = stripDateSuffix(last);
  if (noDate !== last) stages.push(noDate);

  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (key: string): void => {
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    candidates.push(key);
  };
  for (const stage of stages) {
    const forms = [stage, aliasProviderSegment(stage), normalizeSeparators(stage)];
    for (const form of forms) add(form);
    for (const form of forms) add(bareModelName(form));
  }
  return candidates;
}

/**
 * Models we never price, regardless of the table.
 *
 * `<synthetic>` marks locally generated messages that were never billed. Bare
 * family names ("opus", "sonnet") are genuinely ambiguous across generations,
 * so we report them as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

/**
 * Lookups per table, by raw model name. A scan prices every record twice
 * against a few dozen models, and tables are never mutated once built.
 */
const resolvedRates = new WeakMap<RateTable, Map<string, ModelRate | null>>();

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  let resolved = resolvedRates.get(table);
  if (resolved === undefined) {
    resolved = new Map();
    resolvedRates.set(table, resolved);
  }
  let rate = resolved.get(model);
  if (rate === undefined) {
    rate = resolveRate(table, model);
    resolved.set(model, rate);
  }
  return rate;
}

function resolveRate(table: RateTable, model: string): ModelRate | null {
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bareName = bareModelName(key);
  if (bareName.length === 0 || UNPRICEABLE_MODELS.has(bareName)) return null;
  for (const candidate of candidateKeys(key)) {
    const rate = table.get(candidate);
    if (rate !== undefined) return rate;
  }
  return null;
}

/** The parts of a transcript record that decide its price. */
export type PricedRecord = Pick<
  UsageRecord,
  "model" | "rateModel" | "totals" | "speed" | "reportedCostUsd"
>;

export interface PricedUsage {
  readonly costUsd: number;
  readonly costSource: UsageCostSource;
  /** `costUsd` by token category, or `null` when no rates are known to split it. */
  readonly categoryCostUsd: UsageCategoryCost | null;
  /** What `costUsd` exceeds the same tokens at standard rates. `0` without rates. */
  readonly speedPremiumUsd: number;
}

function costByCategory(totals: UsageTokenTotals, rates: TokenRates): UsageCategoryCost {
  return {
    input: totals.uncachedInputTokens * rates.inputCostPerToken,
    cacheRead: totals.cachedInputTokens * rates.cacheReadCostPerToken,
    cacheWrite: totals.cacheCreationTokens * rates.cacheCreationCostPerToken,
    output: totals.outputTokens * rates.outputCostPerToken,
  };
}

function sumCategories(cost: UsageCategoryCost): number {
  return cost.input + cost.cacheRead + cost.cacheWrite + cost.output;
}

/**
 * Prices one record's tokens.
 *
 * A provider-reported cost is kept as is, and split by category and speed in
 * proportion to the model's list rates when those are known.
 *
 * `reasoningTokens` is intentionally not charged separately: it is already
 * counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): PricedUsage {
  const { model, totals, reportedCostUsd } = record;
  const override = overrides?.get(model.trim());
  const reported =
    override === undefined && reportedCostUsd !== null && Number.isFinite(reportedCostUsd)
      ? reportedCostUsd
      : null;
  const unsplit = (costUsd: number, costSource: UsageCostSource): PricedUsage => ({
    costUsd,
    costSource,
    categoryCostUsd: null,
    speedPremiumUsd: 0,
  });
  const rate = override ?? lookupRate(table, record.rateModel ?? model);
  if (rate === null) {
    return reported === null ? unsplit(0, "unpriced") : unsplit(reported, "providerReported");
  }

  const listCost = costByCategory(totals, ratesAt(rate, record.speed));
  const listCostUsd = sumCategories(listCost);
  if (reported !== null && listCostUsd <= 0) return unsplit(reported, "providerReported");
  const premiumUsd =
    record.speed === "standard" ? 0 : listCostUsd - sumCategories(costByCategory(totals, rate));
  const scale = reported === null ? 1 : reported / listCostUsd;
  return {
    costUsd: reported ?? listCostUsd,
    costSource: reported === null ? "modelPriced" : "providerReported",
    categoryCostUsd: {
      input: listCost.input * scale,
      cacheRead: listCost.cacheRead * scale,
      cacheWrite: listCost.cacheWrite * scale,
      output: listCost.output * scale,
    },
    speedPremiumUsd: premiumUsd * scale,
  };
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(
  table: RateTable,
  record: PricedRecord,
  overrides?: RateTable,
): number {
  const rate =
    overrides?.get(record.model.trim()) ?? lookupRate(table, record.rateModel ?? record.model);
  if (rate === null) return 0;
  const rates = ratesAt(rate, record.speed);
  return record.totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken);
}

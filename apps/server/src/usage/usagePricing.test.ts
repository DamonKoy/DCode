import { describe, expect, it } from "@effect/vitest";

import { cursorRateModel } from "@t3tools/provider-cursor/server/accountUsage";
import type { UsageSpeed } from "@t3tools/provider-core/server/usage";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseRateTable,
  priceUsage,
} from "./usagePricing.ts";

const rate = (input: number, cacheRead?: number) => ({
  input_cost_per_token: input,
  output_cost_per_token: input * 5,
  ...(cacheRead === undefined ? {} : { cache_read_input_token_cost: cacheRead }),
});

describe("usage pricing", () => {
  const totals = {
    uncachedInputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 500_000,
  };
  const record = (
    model: string,
    reportedCostUsd: number | null = null,
    speed: UsageSpeed = "standard",
  ) => ({
    model,
    totals,
    reportedCostUsd,
    speed,
  });

  it("uses custom token rates ahead of public and provider-reported costs", () => {
    const table = parseRateTable({ "example-model": rate(1) });
    const overrides = createOverrideRateTable({
      "example-model": {
        inputCostPerMillionTokens: 2,
        outputCostPerMillionTokens: 8,
        cacheReadCostPerMillionTokens: 0.5,
        cacheWriteCostPerMillionTokens: 3,
      },
    });

    for (const reportedCostUsd of [null, 99]) {
      expect(priceUsage(table, record("example-model", reportedCostUsd), overrides)).toMatchObject({
        costUsd: 13.5,
        costSource: "modelPriced",
      });
    }
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(1.5);
  });

  it("prices Cursor cache savings at the base model rate", () => {
    const table = parseRateTable({
      "claude-fable-5-1": rate(10e-6, 1e-6),
      "xai/grok-4.7": rate(2e-6, 0.5e-6),
      "openrouter/x-ai/grok-4.7": rate(3e-6, 0.5e-6),
    });
    const cursorRecord = (model: string) => ({
      ...record(model, 0.25),
      rateModel: cursorRateModel(model),
    });

    expect(cacheSavingsUsd(table, cursorRecord("claude-fable-5-1-thinking-high"))).toBeCloseTo(9);
    expect(cacheSavingsUsd(table, cursorRecord("cursor-grok-4.7-high-fast"))).toBeCloseTo(1.5);
    expect(cacheSavingsUsd(table, cursorRecord("default"))).toBe(0);
    expect(priceUsage(table, cursorRecord("grok-4.7-xhigh-fast"))).toMatchObject({
      costUsd: 0.25,
      costSource: "providerReported",
    });
  });

  it("prices unknown models offline and uses input prices for omitted cache rates", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      "example-model": { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
    });

    expect(priceUsage(table, record("example-model"), overrides)).toMatchObject({
      costUsd: 14,
      costSource: "modelPriced",
    });
    expect(cacheSavingsUsd(table, record("example-model"), overrides)).toBe(0);
  });

  it("preserves explicit zero rates and matches only the exact trimmed model ID", () => {
    const table = parseRateTable({});
    const overrides = createOverrideRateTable({
      " vendor/example-model[1m] ": {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      },
    });
    expect(priceUsage(table, record(" vendor/example-model[1m] ", 99), overrides)).toMatchObject({
      costUsd: 0,
      costSource: "modelPriced",
    });
    for (const model of [
      "example-model[1m]",
      "vendor/example-model",
      "vendor/Example-model[1m]",
      "other/example-model[1m]",
    ]) {
      expect(priceUsage(table, record(model), overrides).costSource).toBe("unpriced");
      expect(priceUsage(table, record(model, 99), overrides)).toEqual({
        costUsd: 99,
        costSource: "providerReported",
        categoryCostUsd: null,
        speedPremiumUsd: 0,
      });
    }
  });

  it("prices fast-mode requests at the model's published fast multiple", () => {
    const table = parseRateTable({
      "claude-opus-5-5": { ...rate(4e-6, 2e-7), provider_specific_entry: { fast: 2, us: 1.1 } },
      "claude-fable-5-1": { ...rate(1e-5, 2.5e-7), provider_specific_entry: { us: 1.1 } },
    });
    const overrides = createOverrideRateTable({
      "claude-opus-5-5": { inputCostPerMillionTokens: 4, outputCostPerMillionTokens: 20 },
    });
    const cost = (model: string, speed: UsageSpeed, custom?: typeof overrides) =>
      priceUsage(table, record(model, null, speed), custom).costUsd;

    expect(cost("claude-opus-5-5", "fast")).toBeCloseTo(2 * cost("claude-opus-5-5", "standard"));
    expect(cacheSavingsUsd(table, record("claude-opus-5-5", null, "fast"))).toBeCloseTo(
      2 * cacheSavingsUsd(table, record("claude-opus-5-5")),
    );
    // No published fast tier, and custom prices, both stay at the standard rate.
    expect(cost("claude-fable-5-1", "fast")).toBe(cost("claude-fable-5-1", "standard"));
    expect(cost("claude-opus-5-5", "fast", overrides)).toBe(
      cost("claude-opus-5-5", "standard", overrides),
    );
  });

  it("splits cost by category and prices the speed premium", () => {
    const table = parseRateTable({
      "claude-opus-5-5": {
        ...rate(4e-6, 4e-7),
        cache_creation_input_token_cost: 5e-6,
        provider_specific_entry: { fast: 2 },
      },
    });
    const split = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
      input: expect.closeTo(input),
      cacheRead: expect.closeTo(cacheRead),
      cacheWrite: expect.closeTo(cacheWrite),
      output: expect.closeTo(output),
    });

    expect(priceUsage(table, record("claude-opus-5-5", null, "fast"))).toEqual({
      costUsd: expect.closeTo(58.8),
      costSource: "modelPriced",
      categoryCostUsd: split(8, 0.8, 10, 40),
      speedPremiumUsd: expect.closeTo(29.4),
    });
    // A reported cost keeps its total and splits in proportion to list rates.
    expect(priceUsage(table, record("claude-opus-5-5", 29.4, "fast"))).toEqual({
      costUsd: 29.4,
      costSource: "providerReported",
      categoryCostUsd: split(4, 0.4, 5, 20),
      speedPremiumUsd: expect.closeTo(14.7),
    });
    // Without rates there is nothing to split it by.
    expect(priceUsage(table, record("unknown-model", 29.4, "fast"))).toMatchObject({
      costUsd: 29.4,
      categoryCostUsd: null,
      speedPremiumUsd: 0,
    });
  });

  it("prices Codex priority and ultrafast requests at their published tier rates", () => {
    const table = parseRateTable({
      "gpt-6-astra": {
        ...rate(1e-5, 1e-6),
        input_cost_per_token_priority: 2e-5,
        output_cost_per_token_priority: 1e-4,
        cache_read_input_token_cost_priority: 2e-6,
        input_cost_per_token_ultrafast: 6e-5,
        output_cost_per_token_ultrafast: 3e-4,
        // No ultrafast cache rate: keeps the standard 10:1 input-to-cache ratio.
      },
      "gpt-6-sol": rate(2e-6, 2e-7),
    });
    const cost = (model: string, speed: UsageSpeed) =>
      priceUsage(table, record(model, null, speed)).costUsd;
    const standard = cost("gpt-6-astra", "standard");

    expect(cost("gpt-6-astra", "fast")).toBeCloseTo(2 * standard);
    expect(cost("gpt-6-astra", "ultrafast")).toBeCloseTo(6 * standard);
    expect(cacheSavingsUsd(table, record("gpt-6-astra", null, "ultrafast"))).toBeCloseTo(
      6 * cacheSavingsUsd(table, record("gpt-6-astra")),
    );
    // A tier the model does not publish bills at the standard rate.
    expect(cost("gpt-6-sol", "ultrafast")).toBe(cost("gpt-6-sol", "standard"));
  });

  it("keeps the canonical Fable rate separate from DeepInfra in either order", () => {
    const canonical = ["claude-fable-5", rate(1e-5, 1e-6)] as const;
    const deepInfra = ["deepinfra/anthropic/claude-fable-5", rate(1e-5)] as const;

    for (const entries of [
      [canonical, deepInfra],
      [deepInfra, canonical],
    ]) {
      const table = parseRateTable(Object.fromEntries(entries));

      expect(lookupRate(table, "claude-fable-5")?.cacheReadCostPerToken).toBe(1e-6);
      expect(lookupRate(table, "deepinfra/anthropic/claude-fable-5")?.cacheReadCostPerToken).toBe(
        1e-5,
      );
      // An unmatched provider prefix falls back to the canonical entry.
      expect(lookupRate(table, "other/claude-fable-5")).toEqual(
        lookupRate(table, "claude-fable-5"),
      );
    }
  });

  it("prices a bracketed context-tier variant at the base model's rate", () => {
    const table = parseRateTable({ "claude-fable-5-1": rate(1e-5, 2.5e-7) });

    expect(lookupRate(table, "claude-fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
    expect(lookupRate(table, "anthropic/Claude-Fable-5-1[1m]")).toEqual(
      lookupRate(table, "claude-fable-5-1"),
    );
  });

  it("adds a bare alias when every qualified entry has the same rate", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(1),
    });

    expect(lookupRate(table, "example-model")).toEqual(
      lookupRate(table, "provider-a/example-model"),
    );
  });

  it("leaves an ambiguous bare name unpriced", () => {
    const table = parseRateTable({
      "provider-a/example-model": rate(1),
      "provider-b/example-model": rate(3),
    });

    expect(lookupRate(table, "provider-a/example-model")?.inputCostPerToken).toBe(1);
    expect(lookupRate(table, "provider-b/example-model")?.inputCostPerToken).toBe(3);
    expect(lookupRate(table, "example-model")).toBeNull();
  });

  it("drops a provider prefix to reach the model's canonical entry", () => {
    const table = parseRateTable({
      "deepseek-v4-flash": rate(3e-7, 6e-9),
      "deepseek/deepseek-v4-flash": rate(5e-7),
    });

    expect(lookupRate(table, "custom-local/DeepSeek-V4-Flash")).toEqual(
      lookupRate(table, "deepseek-v4-flash"),
    );
    // A provider-qualified entry that exists stays exact, ahead of the fallback.
    expect(lookupRate(table, "deepseek/deepseek-v4-flash")?.inputCostPerToken).toBe(5e-7);
  });

  it("prices an unknown provider prefix at the canonical model's rate", () => {
    const table = parseRateTable({ "example-model": rate(1) });

    expect(lookupRate(table, "some-gateway/example-model")).toEqual(
      lookupRate(table, "example-model"),
    );
    // A genuinely unknown model still stays unpriced.
    expect(lookupRate(table, "some-gateway/unknown-model")).toBeNull();
  });

  it("strips quantization and date suffixes down to the base model", () => {
    const table = parseRateTable({ "deepseek-v4-flash": rate(3e-7, 6e-9) });
    const canonical = lookupRate(table, "deepseek-v4-flash");

    expect(lookupRate(table, "DeepSeek-V4-Flash-0731-UD-IQ3_S")).toEqual(canonical);
    expect(lookupRate(table, "deepseek-v4-flash-0731")).toEqual(canonical);
    expect(lookupRate(table, "deepseek-v4-flash-gptq-int4")).toEqual(canonical);
    expect(lookupRate(table, "deepseek-v4-flash-awq")).toEqual(canonical);
    expect(lookupRate(table, "deepseek-v4-flash-q4_k_m")).toEqual(canonical);
  });

  it("does not strip a size or context tail that is not a date or quantization tag", () => {
    const table = parseRateTable({ "example-model": rate(1) });

    expect(lookupRate(table, "example-model-122b")).toBeNull();
    expect(lookupRate(table, "example-model-a10b")).toBeNull();
    expect(lookupRate(table, "example-model-200k")).toBeNull();
  });

  it("maps known domestic provider aliases to the rate table's segment", () => {
    const table = parseRateTable({
      "moonshot/kimi-k2.5": rate(6e-7),
      "zai/glm-5.2": rate(1.4e-6),
    });

    expect(lookupRate(table, "moonshotai/Kimi-K2.5")).toEqual(
      lookupRate(table, "moonshot/kimi-k2.5"),
    );
    expect(lookupRate(table, "zai-org/GLM-5.2")).toEqual(lookupRate(table, "zai/glm-5.2"));
    expect(lookupRate(table, "z-ai/glm-5.2")).toEqual(lookupRate(table, "zai/glm-5.2"));
  });

  it("keeps an ambiguous model unpriced even when a suffix is stripped", () => {
    const table = parseRateTable({
      "provider-a/qwen3.5-122b-a10b": rate(2.6e-7),
      "provider-b/qwen3.5-122b-a10b": rate(4e-7),
    });

    expect(lookupRate(table, "provider-a/qwen3.5-122b-a10b")?.inputCostPerToken).toBe(2.6e-7);
    expect(lookupRate(table, "provider-b/qwen3.5-122b-a10b")?.inputCostPerToken).toBe(4e-7);
    // The bare name conflicts, so dropping the quantization tag cannot price it.
    expect(lookupRate(table, "Qwen/Qwen3.5-122B-A10B-GPTQ-Int4")).toBeNull();
  });

  it("prefers an exact key over a normalized fallback", () => {
    const table = parseRateTable({
      "example-model-int4": rate(5),
      "example-model": rate(1),
    });

    expect(lookupRate(table, "example-model-int4")?.inputCostPerToken).toBe(5);
    expect(lookupRate(table, "example-model-q4_k_m")?.inputCostPerToken).toBe(1);
  });

  it("keeps a user override ahead of every normalized fallback", () => {
    const table = parseRateTable({ "deepseek-v4-flash": rate(3e-7) });
    const overrides = createOverrideRateTable({
      "custom-local/deepseek-v4-flash": {
        inputCostPerMillionTokens: 1,
        outputCostPerMillionTokens: 4,
      },
    });

    // The override is keyed on the full custom id, so it beats the canonical
    // public rate that the prefix fallback would otherwise reach.
    expect(priceUsage(table, record("custom-local/deepseek-v4-flash"), overrides)).toMatchObject({
      costUsd: 7,
      costSource: "modelPriced",
    });
  });
});

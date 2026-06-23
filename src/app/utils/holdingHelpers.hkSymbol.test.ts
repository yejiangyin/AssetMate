import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeHoldingSymbol } from "./holdingHelpers";
import { toYahooSymbol } from "../services/quoteApi";
import { normalizeSearchSymbol } from "../services/securitiesApi";

/**
 * Cross-market HK symbol handling has historically been a source of subtle bugs
 * because the internal storage format (5-digit, no suffix) differs from the
 * Yahoo Finance wire format (4-digit, .HK suffix). These tests pin the full
 * "search → normalize → store → refresh" chain so any change to one of the
 * padStart sites fails loudly instead of silently breaking HK quotes.
 */
describe("HK symbol round-trip", () => {
  test("search result (4-digit .HK) → 5-digit internal → 4-digit Yahoo", () => {
    // Yahoo / securitiesApi returns 4-digit form: "0700.HK"
    const searchSymbol = normalizeSearchSymbol("0700.HK", "HK");
    assert.equal(searchSymbol, "0700");

    // Holdings are stored in 5-digit form (matches EastMoney / Tencent wire fmt)
    const stored = normalizeHoldingSymbol(searchSymbol, "HK");
    assert.equal(stored, "00700");

    // When refreshing, we convert back to Yahoo's 4-digit .HK format
    const yahooSymbol = toYahooSymbol(stored, "HK");
    assert.equal(yahooSymbol, "0700.HK");
  });

  test("handles short numeric codes without dropping leading zeros", () => {
    // A 1-digit HK code like "1" must still round-trip to "00001.HK"
    const stored = normalizeHoldingSymbol("1", "HK");
    assert.equal(stored, "00001");
    const yahooSymbol = toYahooSymbol(stored, "HK");
    assert.equal(yahooSymbol, "0001.HK");
  });

  test("strips an existing .HK suffix before padding", () => {
    const stored = normalizeHoldingSymbol("0700.HK", "HK");
    assert.equal(stored, "00700");
    const stored2 = normalizeHoldingSymbol("9988.HK", "HK");
    assert.equal(stored2, "09988");
  });

  test("non-HK markets pass through unchanged", () => {
    assert.equal(normalizeHoldingSymbol("AAPL", "US"), "AAPL");
    assert.equal(normalizeHoldingSymbol("7203.T", "JP"), "7203.T");
    assert.equal(normalizeHoldingSymbol("600519", "A"), "600519");
  });
});

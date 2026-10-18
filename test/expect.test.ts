import { describe, expect, it } from "vitest";
import type { Expectation } from "../src/config.js";
import { findMismatches } from "../src/expect.js";

const expectation = (overrides: Partial<Expectation> = {}): Expectation => ({
  functionError: false,
  exact: false,
  ...overrides,
});

describe("findMismatches", () => {
  it("matches objects by the listed keys only", () => {
    expect(
      findMismatches(expectation({ payload: { statusCode: 200, body: { ok: true } } }), {
        statusCode: 200,
        payload: { statusCode: 200, body: { ok: true, extra: 1 }, headers: {} },
      }),
    ).toEqual([]);
  });

  it("reports each differing value with its location", () => {
    expect(
      findMismatches(expectation({ payload: { statusCode: 200, items: [1, { id: "a" }] } }), {
        statusCode: 200,
        payload: { statusCode: 500, items: [1, { id: "b" }] },
      }),
    ).toEqual([
      "payload.statusCode: expected 200, received 500",
      "payload.items[1].id: expected 'a', received 'b'",
    ]);
  });

  it("requires arrays to have the same length", () => {
    expect(findMismatches(expectation({ payload: [1, 2] }), { payload: [1, 2, 3] })).toHaveLength(
      1,
    );
  });

  it("rejects extra keys when exact", () => {
    expect(
      findMismatches(expectation({ payload: { ok: true }, exact: true }), {
        payload: { ok: true, debug: "x" },
      }),
    ).toEqual(["payload.debug: unexpected"]);
  });

  it("fails on a function error unless one is expected", () => {
    expect(findMismatches(expectation(), { statusCode: 200, functionError: "Unhandled" })).toEqual([
      "function error: Unhandled",
    ]);
    expect(
      findMismatches(expectation({ functionError: true }), { functionError: "Unhandled" }),
    ).toEqual([]);
    expect(findMismatches(expectation({ functionError: true }), { statusCode: 200 })).toEqual([
      "function error: expected one, received none",
    ]);
  });

  it("checks the invoke status code when given", () => {
    expect(findMismatches(expectation({ statusCode: 200 }), { statusCode: 202 })).toEqual([
      "status code: expected 200, received 202",
    ]);
  });

  it("compares non-JSON responses as strings and handles missing payloads", () => {
    expect(findMismatches(expectation({ payload: "pong" }), { payload: "pong" })).toEqual([]);
    expect(findMismatches(expectation({ payload: { ok: true } }), {})).toEqual([
      "payload: expected { ok: true }, received nothing",
    ]);
  });

  it("doesn't print values under secret-looking keys", () => {
    const [mismatch] = findMismatches(expectation({ payload: { apiKey: "expected-key" } }), {
      payload: { apiKey: "real-secret" },
    });

    expect(mismatch).toBe("payload.apiKey: doesn't match the expected value");
  });
});

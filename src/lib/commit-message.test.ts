import { describe, expect, it } from "vitest";

import { commitResponseFormat, parseCommitResponse, validateCommitMessage } from "./commit-message";

describe("commitResponseFormat", () => {
  it("uses bounded character classes with escapes supported by llama.cpp", () => {
    const { properties } = commitResponseFormat("fix").json_schema.schema;
    for (const { pattern } of [properties.description, properties.scope]) {
      expect(pattern).not.toMatch(/\\[sSdDwWpP]/);
      expect(pattern).not.toContain("*");
      expect(pattern).not.toContain("+");
      expect(pattern).toMatch(/\{\d+,\d+\}\$$/);
    }
    expect(new RegExp(properties.description.pattern, "u").test("x".repeat(160))).toBe(true);
    expect(new RegExp(properties.description.pattern, "u").test("x".repeat(161))).toBe(false);
    expect(new RegExp(properties.scope.pattern, "u").test("x".repeat(32))).toBe(true);
    expect(new RegExp(properties.scope.pattern, "u").test("x".repeat(33))).toBe(false);
  });
});

describe("parseCommitResponse", () => {
  it.each(["fix", undefined] as const)("uses the same string bounds with type=%s", (type) => {
    const value = { description: "x".repeat(160), scope: "x".repeat(32), ...(!type ? { type: "fix", breaking: false } : {}) };
    expect(parseCommitResponse(JSON.stringify(value), type)).toBe(`fix(${value.scope}): ${value.description}`);
    for (const invalid of [{ ...value, description: "x".repeat(161) }, { ...value, scope: "x".repeat(33) }]) {
      expect(() => parseCommitResponse(JSON.stringify(invalid), type)).toThrow("must support strict JSON Schema");
    }
  });

  it.each([" ", "\t", "\n", "\u00a0", "\u1680", "\u2003", "\u202f", "\ufeff"])("rejects whitespace with explicit character ranges: %j", (space) => {
    expect(() => parseCommitResponse(JSON.stringify({ description: `${space}test`, scope: null }), "fix")).toThrow();
    expect(() => parseCommitResponse(JSON.stringify({ description: "test", scope: `a${space}b` }), "fix")).toThrow();
  });
});

describe("validateCommitMessage", () => {
  it.each([72, 73, 100, 200, 1_000])("accepts a valid header of %i characters", (length) => {
    expect(validateCommitMessage(`feat: ${"x".repeat(length - 6)}`)).toBeUndefined();
  });

  it("reports every detectable validation problem together", () => {
    const error = validateCommitMessage(`banana: ${"x".repeat(70)}\tmore`, "feat!");
    expect(error).toContain("without control characters");
    expect(error).toContain("Supported types:");
    expect(error).toContain('The type must be exactly "feat".');
    expect(error).toContain('Include "!" immediately before ":"');
    const blankError = validateCommitMessage(`${" ".repeat(73)}\t`);
    expect(blankError).toContain("Message cannot be empty.");
    expect(blankError).toContain("without control characters");
  });

  it.each(["feat: add an endpoint", "deps: update packages", "feat!: remove an endpoint", "refactor(api)!: remove the old API"])("accepts %s", (message) => {
    expect(validateCommitMessage(message)).toBeUndefined();
  });

  it.each(["", "banana: invalid", "FEAT: invalid", "feat: ", "feat!: ", "feat!!: invalid", "feat(): invalid", "feat: first\nsecond"])("rejects %j", (message) => {
    expect(validateCommitMessage(message)).toEqual(expect.any(String));
  });

  it("enforces the forced type without preventing automatic breaking changes", () => {
    expect(validateCommitMessage("feat!: remove an endpoint", "feat")).toBeUndefined();
    expect(validateCommitMessage("feat(api)!: remove an endpoint", "feat!")).toBeUndefined();
    expect(validateCommitMessage("fix: repair an endpoint", "feat")).toEqual(expect.any(String));
    expect(validateCommitMessage("feat: add an endpoint", "feat!")).toEqual(expect.any(String));
    expect(validateCommitMessage(`feat: ${"x".repeat(66)}`)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import {
  applyCommitType,
  sanitizeCommitMessage,
  validateCommitMessage,
} from "./commit-message";

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

describe("sanitizeCommitMessage", () => {
  it("keeps only the first line", () => {
    expect(sanitizeCommitMessage("feat: add x\nbody line\nmore")).toBe("feat: add x");
  });

  it("strips backticks and double quotes", () => {
    expect(sanitizeCommitMessage('`fix: "quoted" thing`')).toBe("fix: quoted thing");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeCommitMessage("   chore: tidy up   ")).toBe("chore: tidy up");
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeCommitMessage("")).toBe("");
  });

  it.each(["feat!: remove the old API", "feat(api)!: remove the old API"])("preserves the breaking change marker in %s", (message) => {
    expect(sanitizeCommitMessage(`\`${message}\`\nExplanation`)).toBe(message);
  });
});

describe("applyCommitType", () => {
  it("preserves the base prompt", () => {
    expect(applyCommitType("BASE", "feat").startsWith("BASE")).toBe(true);
  });

  it("injects the forced type into the prompt", () => {
    expect(applyCommitType("BASE", "fix")).toContain("fix");
  });

  it("separates the forced type from its breaking change marker", () => {
    const prompt = applyCommitType("BASE", "feat!");
    expect(prompt).toContain('The type MUST be exactly "feat".');
    expect(prompt).toContain('Include "!" immediately before ":" to mark a breaking change.');
  });
});

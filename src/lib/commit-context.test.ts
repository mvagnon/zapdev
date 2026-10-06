import { expect, it } from "vitest";

import { prepareCommitContext } from "./commit-context";

function stagedDiff(files: Record<string, string>): string {
  const entries = Object.entries(files);
  return entries.map(([path]) => `1\t0\t${path}\0`).join("") + "\0"
    + entries.map(([path, patch]) => `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n${patch}\n`).join("");
}

it("omits ignored content but keeps every path and its statistics, including dependency manifests", () => {
  const diff = stagedDiff({
    "src/api.ts": "+export function api() {}", "package-lock.json": "+LOCKFILE_NOISE",
    "nested/yarn.lock": "+MORE_LOCKFILE_NOISE", "package.json": '+{"dependencies": {"foo": "2"}}',
    "dist/bundle.js": "+GENERATED_NOISE", "image.bin": "Binary files differ",
  }).replace("1\t0\timage.bin", "-\t-\timage.bin");
  const context = prepareCommitContext(diff, "# Noise\npackage-lock.json\nyarn.lock\ndist/\n");
  for (const path of ["src/api.ts", "package-lock.json", "nested/yarn.lock", "package.json", "dist/bundle.js", "image.bin"]) {
    expect(context).toContain(JSON.stringify(path));
  }
  expect(context).toContain('+1 -0 "package-lock.json" (content omitted)');
  expect(context).toContain('binary "image.bin" (content omitted)');
  expect(context).toContain("+export function api() {}");
  expect(context).toContain('"dependencies"');
  expect(context).not.toMatch(/LOCKFILE_NOISE|GENERATED_NOISE|Binary files differ/);
});

it("uses gitignore negations, root anchoring and case-sensitive patterns", () => {
  const context = prepareCommitContext(stagedDiff({
    "src/drop.generated.ts": "+DROP", "src/keep.generated.ts": "+KEEP", "src/CAPS.GENERATED.TS": "+CAPS",
    "root.txt": "+ROOT", "nested/root.txt": "+NESTED", "other/comment.txt": "+COMMENT",
  }), "*.generated.ts\n!keep.generated.ts\n/root.txt\n# other/comment.txt\n");
  expect(context).not.toContain("+DROP");
  expect(context).not.toContain("+ROOT");
  for (const content of ["+KEEP", "+CAPS", "+NESTED", "+COMMENT"]) expect(context).toContain(content);
});

it("shares the budget across files, preserving both ends and marking omitted hunks", () => {
  const context = prepareCommitContext(stagedDiff({
    "a.ts": "+START_A\n" + "+a\n".repeat(1_000) + "+END_A",
    "b.ts": "+START_B\n" + "+b\n".repeat(1_000) + "+END_B", "c.ts": "+SMALL",
  }), "", 1_000);
  expect(context.length).toBeLessThanOrEqual(1_000);
  for (const content of ["+START_A", "+END_A", "+START_B", "+END_B", "+SMALL", "[diff truncated]"]) {
    expect(context).toContain(content);
  }
});

it("preserves unusual filenames and rename metadata without parsing quoted patch headers", () => {
  const path = "src/new\tfile\nété.ts";
  const diff = `0\t0\t\0src/old.ts\0${path}\0\0diff --git a/src/old.ts ${JSON.stringify(`b/${path}`)}\nsimilarity index 100%\nrename from src/old.ts\n`;
  const context = prepareCommitContext(diff, "");
  expect(context).toContain(`${JSON.stringify("src/old.ts")} -> ${JSON.stringify(path)}`);
  expect(context).toContain("similarity index 100%");
});

it("still provides useful context when all content is ignored", () => {
  expect(prepareCommitContext(stagedDiff({ "yarn.lock": "+NOISE" }), "*.lock"))
    .toBe('Changed files:\n+1 -0 "yarn.lock" (content omitted)');
});

it("fails rather than dropping file names when the inventory alone exceeds the budget", () => {
  expect(() => prepareCommitContext(stagedDiff({ "very-long-name.ts": "+CODE" }), "", 10))
    .toThrow("Too many changed files");
});

it("respects tiny remaining patch budgets without emitting a whole patch accidentally", () => {
  const diff = stagedDiff({ "a.ts": "+CODE\n".repeat(20) });
  const summaryLength = 'Changed files:\n+1 -0 "a.ts"'.length;
  for (let budget = 0; budget < 50; budget++) {
    expect(prepareCommitContext(diff, "", summaryLength + budget).length).toBeLessThanOrEqual(summaryLength + budget);
  }
});

it("rejects a diff without machine-readable statistics", () => {
  expect(() => prepareCommitContext("diff --git a/api.ts b/api.ts\n+CODE", ""))
    .toThrow("Invalid staged diff");
});

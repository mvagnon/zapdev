import { expect, it } from "vitest";

import { buildPrDescription } from "./pr";

it("groups every commit deterministically, preserving scopes and nonconventional subjects", () => {
  expect(buildPrDescription([
    "fix(api): handle missing users\n\nImplementation details.",
    "feat: add search",
    "docs: explain search",
    "fix: handle empty queries",
    "custom(worker): retry jobs",
    "Merge branch 'main' into feature",
  ], "https://trello.com/c/abc/task")).toBe([
    "### Features\n\n- add search",
    "### Bug Fixes\n\n- **api:** handle missing users\n- handle empty queries",
    "### Documentation\n\n- explain search",
    "### Other Changes\n\n- **worker:** retry jobs\n- Merge branch 'main' into feature",
    "Closes https://trello.com/c/abc/task",
  ].join("\n\n"));
});

it("highlights breaking headers and multiline footers without swallowing other trailers", () => {
  expect(buildPrDescription([
    "feat(api)!: remove v1",
    "refactor: change auth\n\nBREAKING CHANGE: tokens now expire\n  after one hour\n\nRefs: #42",
    "fix: change errors\n\nBREAKING-CHANGE: errors use codes\nReviewed-by: Jane",
  ])).toBe([
    "### BREAKING CHANGES\n\n- **api:** remove v1\n- tokens now expire after one hour\n- errors use codes",
    "### Features\n\n- **api:** remove v1",
    "### Bug Fixes\n\n- change errors",
    "### Code Refactoring\n\n- change auth",
  ].join("\n\n"));
});

it.each(["not a url", "javascript:alert(1)", "https://example.com/\nCloses#1", "https://user:secret@example.com/task", ""])(
  "rejects invalid task URLs: %j", (url) => {
    expect(() => buildPrDescription(["fix: test"], url)).toThrow("--closes must be an HTTP(S) task URL");
  },
);

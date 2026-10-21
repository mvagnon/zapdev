const SECTIONS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance Improvements",
  revert: "Reverts",
  deps: "Dependencies",
  docs: "Documentation",
  style: "Styles",
  refactor: "Code Refactoring",
  test: "Tests",
  build: "Build System",
  ci: "Continuous Integration",
  chore: "Miscellaneous Chores",
};

/** Validate an optional task URL before using it in the PR body. */
export function validateClosesUrl(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const message = "--closes must be an HTTP(S) task URL without credentials or whitespace.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\s<>\p{Cc}]/u.test(value)) {
    throw new Error(message);
  }
  return value;
}

/** Format Conventional Commit subjects and breaking notes without any LLM calls. */
export function buildPrDescription(commits: string[], closes?: string): string {
  const task = validateClosesUrl(closes);
  const groups = new Map<string, string[]>();
  const add = (section: string, entry: string): void => {
    const entries = groups.get(section) ?? [];
    entries.push(`- ${entry}`);
    groups.set(section, entries);
  };
  for (const message of commits) {
    const subject = message.split("\n")[0]!;
    const match = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (\S.*)$/.exec(subject);
    const scope = match?.[2] ? `**${match[2]}:** ` : "";
    const entry = `${scope}${match?.[4] ?? subject}`;
    const section = match && Object.hasOwn(SECTIONS, match[1]!) ? SECTIONS[match[1]!]! : "Other Changes";
    add(section, entry);
    const notes = [...message.matchAll(/^BREAKING[ -]CHANGE:\s*(\S[^\n]*(?:\n(?!\s*$|[\w-]+:)[^\n]+)*)/gm)];
    if (notes.length) {
      for (const note of notes) add("BREAKING CHANGES", `${scope}${note[1]!.replace(/\s+/g, " ").trim()}`);
    } else if (match?.[3]) add("BREAKING CHANGES", entry);
  }
  const order = ["BREAKING CHANGES", ...Object.values(SECTIONS), "Other Changes"];
  const sections = order.filter((section) => groups.has(section))
    .map((section) => `### ${section}\n\n${groups.get(section)!.join("\n")}`);
  if (task) sections.push(`Closes ${task}`);
  return sections.join("\n\n");
}

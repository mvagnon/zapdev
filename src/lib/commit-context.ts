import ignore from "ignore";

const MAX_CONTEXT_CHARS = 12_000;
const TRUNCATION_MARKER = "\n[diff truncated]\n";

/** Build bounded context from Git's combined NUL-delimited numstat and patch output. */
export function prepareCommitContext(diff: string, patterns: string, max: number = MAX_CONTEXT_CHARS): string {
  const separator = diff.indexOf("\0\0");
  if (separator < 0) throw new Error("Invalid staged diff: missing file statistics.");
  const entries = diff.slice(0, separator).split("\0");
  const patches = diff.slice(separator + 2).split(/(?=^diff --git )/m);
  const matcher = ignore({ ignorecase: false }).add(patterns);
  const inventory: string[] = [];
  const included: { patch: string; index: number }[] = [];
  let fileIndex = 0;

  for (let index = 0; index < entries.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entries[index]!);
    if (!match) throw new Error("Invalid staged diff: malformed file statistics.");
    let path = match[3]!;
    let previousPath: string | undefined;
    if (!path) {
      previousPath = entries[++index];
      path = entries[++index] ?? "";
    }
    if (!path || previousPath === "") throw new Error("Invalid staged diff: missing file path.");
    const patch = patches[fileIndex];
    if (!patch?.startsWith("diff --git ")) throw new Error("Invalid staged diff: missing file patch.");
    const binary = match[1] === "-";
    const omitted = binary || matcher.ignores(path);
    const name = previousPath ? `${JSON.stringify(previousPath)} -> ${JSON.stringify(path)}` : JSON.stringify(path);
    const counts = binary ? "binary" : `+${match[1]} -${match[2]}`;
    const status = patch.includes("\nnew file mode ") ? " (new)" : patch.includes("\ndeleted file mode ") ? " (deleted)" : "";
    inventory.push(`${counts} ${name}${status}${omitted ? " (content omitted)" : ""}`);
    if (!omitted) included.push({ patch: `\n\n${patch}`, index: fileIndex });
    fileIndex++;
  }
  if (fileIndex !== patches.length) throw new Error("Invalid staged diff: inconsistent file inventory.");

  const summary = `Changed files:\n${inventory.join("\n")}`;
  if (summary.length > max) throw new Error("Too many changed files to fit the commit context. Stage fewer files.");
  let remaining = max - summary.length;
  const selected: string[] = [];
  included.sort((left, right) => left.patch.length - right.patch.length);
  for (const [index, file] of included.entries()) {
    const budget = Math.floor(remaining / (included.length - index));
    const patch = truncatePatch(file.patch, budget);
    selected[file.index] = patch;
    remaining -= patch.length;
  }
  return summary + selected.join("");
}

function truncatePatch(patch: string, max: number): string {
  if (patch.length <= max) return patch;
  if (max < TRUNCATION_MARKER.length) return "";
  // TODO: ponytail: head/tail sampling omits middle hunks; select individual hunks if needed.
  const budget = max - TRUNCATION_MARKER.length;
  const head = patch.slice(0, Math.ceil(budget / 2));
  const tailBudget = Math.floor(budget / 2);
  const tail = tailBudget ? patch.slice(-tailBudget) : "";
  return head.slice(0, Math.max(0, head.lastIndexOf("\n"))) + TRUNCATION_MARKER
    + tail.slice(tail.indexOf("\n") + 1);
}

# `zapdev` Project Instructions

zapdev is a lightweight CLI made in TypeScript to help developers make the small repetitive git-based tasks fast, precise and even easier.

## Dependencies

- `@clack/prompts` for pretty TUI prompts
- `Citty` for great CLI experience
- `tinyexec` to spawn git processes (direct spawn, no shell)
- `esbuild` to bundle everything (deps included) into a single `dist/cli.js` at publish time
- `ESLint` for linting
- `Vitest` for unit testing

And Node.js (>= 20) as a runtime, npm as package manager. An OpenAI-compatible Chat Completions endpoint is called over plain `fetch` (`src/lib/llm.ts`), configured explicitly with `ZD_URL`, `ZD_MODEL`, and `ZD_EFFORT`; no SDK. The published package has zero runtime `dependencies`: everything is inlined in the bundle.

## Architecture

`src/` layout — respect these boundaries when adding code:

- `src/index.ts` — bin launcher; enables the V8 compile cache, then dynamically imports `cli.js`.
- `src/cli.ts` — CLI entry (Citty); registers subcommands, defaults to `commit`.
- `src/commands/` — one file per command. UI and orchestration only (prompts, spinners, control flow); delegate real work to `lib/`.
- `src/lib/` — the logic. Pure, testable functions (validation, transformation, parsing) that are unit-tested, and side effects (`git`, `llm`) isolated in their own modules; shared helpers (`errors`).
- `src/prompts/` — LLM prompts as `.md` files, imported as text (esbuild `.md` text loader) and inlined into the bundle at build time.
- `src/types/` — shared type declarations, one file per domain (`config.ts`, `commit.ts`), plus ambient module declarations (`markdown.d.ts`).

Conventions:

- Dependencies flow one way: `types/` is a leaf (never imports from `lib`/`commands`); `commands/` → `lib/` → `prompts/` + `types/`.
- A type used by more than one module goes in `types/`; a type local to a single file stays colocated with it. Runtime values (const arrays, functions) stay with their logic — but when a domain type derives from a const (e.g. `COMMIT_TYPES` + `CommitType`), keep both in the domain's `types/` file to preserve a single source of truth.
- Prompts: keep instructions static in the `.md`; assemble conditional or parameterized parts in TS (a function taking the base prompt as an argument), and pass runtime data (diffs, context) through chat messages — never bake it into the file.
- Keep `.md` imports out of the test graph: functions that shape prompts receive the prompt string as an argument instead of importing the `.md`, so Vitest never resolves a text import.

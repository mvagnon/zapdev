<p align="center">
  <img src="https://raw.githubusercontent.com/mvagnon/zapdev/main/.github/assets/preview.gif" alt="zapdev CLI demonstration">
</p>

---

[![portfolio](https://img.shields.io/website?url=https%3A%2F%2Fmvagnon.dev&up_message=Visit&label=Portfolio&color=%23007fff)](https://mvagnon.dev)
[![buymeacoffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/mvagnon)

# zapdev

> [!TIP]
> **Working with an AI assistant?** Use **[zapdev-mcp](https://github.com/mvagnon/zapdev-mcp)**
> to expose repository, commit, and pull request tools directly to your MCP client.

## Project Introduction

**zapdev** is a lightweight TypeScript CLI that makes small, repetitive Git chores fast and precise.

It stages changes, scans them for secrets, and generates Conventional Commit messages for one repository or several direct child repositories in a single review flow.

## Project Architecture

```mermaid
flowchart LR
  Entry["src/index.ts"] --> CLI["src/cli.ts"]
  CLI --> Commands["src/commands"]
  Commands --> Lib["src/lib"]
  Commands --> Types["src/types"]
  Lib --> Prompts["src/prompts"]
  Lib --> Types
  Lib --> Tools["Git, Gitleaks, LLM API"]
```

- `src/index.ts`: bin launcher; enables the V8 compile cache, then loads `cli.js`.
- `src/cli.ts`: CLI entry; registers `commit` as the default command.
- `src/commands/`: command UI and orchestration.
- `src/lib/`: pure logic and isolated Git, Gitleaks, and LLM side effects.
- `src/prompts/`: LLM prompts inlined into the bundle at build time.
- `src/types/`: shared type declarations.

## Environment Variables

| Variable          | Required     | Description                                                                                         |
| ----------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `ZD_URL`          | For `commit` / `pr` | Complete HTTP(S) Chat Completions endpoint, including its path                                      |
| `ZD_MODEL`        | For `commit` / `pr` | Model identifier supported by the endpoint                                                          |
| `ZD_EFFORT`       | For `commit` / `pr` | Sent as `reasoning_effort`; use a value supported by your model, such as `low`, `medium`, or `high` |
| `ZD_API_KEY`      | No           | API key sent as `Authorization: Bearer <key>`; omit for endpoints without authentication            |
| `ZD_HOOK_TIMEOUT` | No           | Deadline per Git hook in seconds (default: `60`); positive numbers from `0.001` to `2147483.647`    |

The LLM settings have no defaults, automatic provider detection, or backup models. CLI flags override these settings. Legacy `OLLAMA_*` variables are no longer read.

Requests use the OpenAI Chat Completions format over plain `fetch`, without a provider SDK. Set `ZD_API_KEY` if your endpoint requires Bearer authentication; when absent or blank, no authentication header is sent. The endpoint and model must support `reasoning_effort` and **strict Structured Outputs** (`response_format.type: "json_schema"`, `strict: true`), including string `pattern` constraints with character ranges and bounded repetitions. OpenAI compatibility or JSON mode alone is not sufficient. There is no plain-text fallback.

## Setup

### Requirements

- **Node.js >= 20 (required):** runs the CLI.
- **Git (required):** provides the repository operations.
- **OpenAI-compatible Chat Completions endpoint and model with strict JSON Schema Structured Outputs support (required for `commit` and `pr`):** generates commit messages and PR titles.
- **GitHub CLI (`gh`, required for `pr`):** install it and authenticate with `gh auth login`.
- **Gitleaks (recommended):** scans staged changes before message generation when available on `PATH`.

### Install

Install zapdev globally for daily use:

```bash
npm install -g zapdev
```

or

```bash
bun install -g zapdev
```

Or run it once without installing:

```bash
npx zapdev commit
```

### Model Configuration

Choose one configuration before running `zapdev commit`. Use the complete Chat Completions URL, not just the API base URL.

#### Local model

Start an OpenAI-compatible local server and load a model (for example, in LM Studio). Check that the server/model combination enforces strict JSON Schema structured outputs, then use its model identifier and supported reasoning effort:

```bash
export ZD_URL="http://localhost:1234/v1/chat/completions"
export ZD_MODEL="your-local-model-id"
export ZD_EFFORT="low"
unset ZD_API_KEY
zapdev commit
```

No API key is needed for a server without authentication. If your local server requires one, set `ZD_API_KEY` instead.

#### OpenRouter

Create an API key at [OpenRouter](https://openrouter.ai/settings/keys) and choose a [model/provider supporting structured outputs](https://openrouter.ai/models?supported_parameters=structured_outputs):

```bash
export ZD_URL="https://openrouter.ai/api/v1/chat/completions"
export ZD_MODEL="your-structured-output-model-id"
export ZD_EFFORT="low"
export ZD_API_KEY="your-openrouter-api-key"
zapdev commit
```

Model availability, quotas, supported reasoning efforts, and JSON Schema enforcement depend on the model and provider. zapdev sends `provider.require_parameters: true` to OpenRouter so requests are routed only to providers supporting the requested parameters. Keep your API key private.

Requests to `openrouter.ai` automatically include `HTTP-Referer: https://mvagnon.dev/zapdev-cli` and `X-OpenRouter-Title: zapdev CLI` for app attribution. These headers are not sent to local servers or other endpoints.

Provider errors display the HTTP status and available error code, provider name, error type, and raw details; JSON details are formatted for readability. Errors returned inside HTTP 200 responses also stop the commit flow. Check [OpenRouter Activity](https://openrouter.ai/activity) for additional diagnostics.

### Development Setup

From a clone:

```bash
npm install
```

| Command                | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `npm run zapdev`       | Build and run the CLI                          |
| `npm run typecheck`    | Check TypeScript types                         |
| `npm run lint`         | Run ESLint                                     |
| `npm run knip`         | Check unused files, exports, and dependencies  |
| `npm run test`         | Run Vitest                                     |
| `npm run staticchecks` | Run lint, typecheck, Knip, and tests, as in CI |
| `npm run build`        | Bundle to `dist/` with esbuild                 |

`npm link` exposes the local `zapdev` binary after `npm run build`.

## Usage

Run `zapdev` or `zapdev commit` to start the commit flow. Both accept the flags below.

### `zapdev commit`

Stages changes, scans for secrets with Gitleaks when installed, generates Conventional Commit messages, then lets you review and optionally push.

- **Repositories:** uses the current Git repository (including from a subdirectory), or direct child repositories when outside one. No recursive search; `node_modules` is excluded.
- **Review:** commit all, commit one repository, edit a message, or cancel. Unselected changes remain staged.
- **Push:** asks once, only for repositories committed during this run. Use `--push` to skip confirmation or `--no-push` to keep commits local. With `--yes`, nothing is pushed unless `--push` is explicitly set.

| Flag                        | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `--url <url>`               | Override the Chat Completions endpoint                                          |
| `--model <model>`           | Override the model                                                              |
| `--effort <effort>`         | Override the reasoning effort                                                   |
| `-t, --type <type>`         | Force a commit type; append `!` for a breaking change                           |
| `-T, --ask-for-type`        | Choose a type for all commits, then confirm breaking (default: no)              |
| `-p, --push`                | Push without confirmation                                                       |
| `--no-push`, `--push=false` | Keep commits local without confirmation                                         |
| `--pull`                    | Pull fast-forward updates before staging                                        |
| `--branch <name>`           | Use this branch in every repository without asking; create it if needed         |
| `-A, --ask-for-branch`      | Ask for a branch before every commit                                            |
| `-s, --staged`              | Commit only already-staged changes                                              |
| `-y, --yes`                 | Skip default prompts and keep commits local; all explicit flags take precedence |

```bash
zapdev commit              # review messages, commit, then confirm push
zapdev commit -t feat      # force the commit type
zapdev commit -t 'feat!'   # force a breaking change
zapdev commit -syp         # commit staged changes and push without review
zapdev commit --pull       # pull first, then follow the normal flow
zapdev commit --branch="feature/shared" --yes # commit all repositories on this branch without default prompts
```

Supported types: `feat`, `fix`, `deps`, `chore`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `revert`. Messages should aim for 72 characters. The generation schema limits descriptions to 160 characters and scopes to 32 to prevent runaway output; manually edited messages can be longer. Generation has a 25-second timeout and no retries.

**Message generation:** in automatic mode, the model returns `type`, `scope` (or `null`), `breaking`, and `description` as structured fields; zapdev assembles `type(scope)!: description` locally. With `--type` or a manually selected type, the model returns only `scope` (or `null`) and `description`; zapdev uses the exact selected type and any explicit `!` to assemble the header. Scope is optional in both modes: `null` omits it. Selecting `auto` keeps automatic generation. There are no commit-format correction retries; refusals, incomplete responses, and endpoints that do not honor the schema stop the flow before committing.

All explicit flags override `--yes`, regardless of argument order: `-T` asks for the type and breaking change, `-A` asks for branches, `--push` pushes, `--no-push` keeps commits local, `--pull` pulls first, and `--staged` commits only already-staged changes. `--type`, `--url`, `--model`, and `--effort` still apply. Unrequested prompts stay skipped; `--type` preselects the type when `-T` is set.

**Branches:** `--branch <name>` uses the given local branch in every selected repository without a branch prompt, even with `-A`. It switches to the existing branch or creates it from HEAD **before the commit**, preserving pending changes without force. Otherwise, before committing on `main`, `master`, `principal`, `dev`, or `development`, zapdev asks for a local branch unless `--yes` is set. A different name switches to an existing branch or creates it **before the commit**. Prompts reuse the previous input; empty input keeps the current branch. `-A` asks on every branch, including with `--yes`, unless `--branch` is supplied.

**Safety:** a failed Gitleaks scan stops the flow before any commit or sending that repository's diff to the LLM. Without Gitleaks, scanning is skipped. Commit context is sent to your configured endpoint, which may be remote; binary content and patches matching `src/config/diff.gitignore` are omitted, but those files are still committed.

**Git:** `--pull` only pulls repositories with changes to commit and a configured upstream, without rebase or automatic stash. Push uses the current branch's name and its upstream remote, then `origin`, then the only remote; ambiguous or missing remotes are skipped. No force-push. Errors stop the flow without undoing earlier pulls or commits; cancelling branch selection also stops all pushes.

**Without a terminal:** review is skipped, explicit `-T` / `-A` prompts are refused even with `--yes` (`--branch` bypasses `-A`), and protected branches require `--yes` or `--branch` to commit without a branch prompt. Commits stay local unless `--push` is set. Git hooks have a 60-second timeout (`ZD_HOOK_TIMEOUT` to override); interactive hooks must use `/dev/tty`.

### `zapdev pr`

Creates a GitHub pull request for the current repository and branch. Outside a Git repository, detects direct child repositories, like `commit`.

```bash
zapdev pr
zapdev pr -b develop
zapdev pr -y -b develop
zapdev pr --closes https://github.com/owner/repo/issues/123
zapdev pr -c https://trello.com/c/abc/task
```

| Flag | Description |
| ---- | ----------- |
| `-c, --closes <url>` | Append `Closes <url>` for the PM task; optional HTTP(S) URL |
| `-b, --branch <name>` | Target branch; defaults to the GitHub repository's default branch |
| `-y, --yes` | Push branches and create all PRs without confirmation |
| `--url`, `--model`, `--effort` | Override the same LLM settings as `commit` |

- Requires a clean working tree, including staged, unstaged and untracked files. Otherwise, stops before fetching, generating a title or pushing, with instructions to commit or stash changes. This also applies with `--yes` and without a terminal.
- Fetches the target branch (`--branch`, or the GitHub repository's default branch), then reads **all complete commit messages unique to the current branch** relative to that target, oldest first. Uses the upstream remote, then `origin`, then the only remote; ambiguous remotes are refused.
- Generates a Conventional Commit-style title with the configured LLM. Commit messages are sent in full, without truncation; the model's context limit still applies.
- Builds the description locally: bullet points grouped by commit type, bold scopes, and a separate breaking-changes section for `!`, `BREAKING CHANGE:`, or `BREAKING-CHANGE:`. Unlike a release changelog, all types are included; nonconventional subjects go under Other Changes.
- Shows the title and description, then asks before pushing and creating the PR. With `--yes` / `-y` or without a terminal, proceeds without confirmation. Never force-pushes or stages pending changes.
- With multiple repositories, prepares PRs in parallel and lets you create all PRs or just one. Every repository must have a clean working tree and a valid PR context; preparation failures stop the command before any push or PR creation. `--branch` and `--closes` apply to every PR.
- Targets the selected remote's repository; does not create forks. `Closes` adds a reference, not a direct PM API action; automatic task closure depends on the provider's integration.

### Zed IDE

For a faster review and commit workflow, review and stage changes from Zed's Git panel, then run `zapdev commit -syp` from a task. The command commits only staged changes, skips all prompts, and pushes the current branch, including protected branches.

Add the following tasks to `.zed/tasks.json`:

```json
[
  {
    "label": "zapdev commit",
    "command": "zapdev commit --yes",
    "reveal": "always",
    "hide": "on_success",
    "reveal_target": "center"
  }
]
```

Add this entry to Zed's `keymap.json` to run the commit task with `ctrl-cmd-enter`:

```json
{
  "context": "Pane",
  "bindings": {
    "ctrl-cmd-enter": ["task::Spawn", { "task_name": "zapdev commit" }]
  }
}
```

### Shell Aliases

```bash
alias commit="zapdev commit --yes"
```

## Other

zapdev is available under the MIT license.

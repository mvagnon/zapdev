<p align="center">
  <img src="https://raw.githubusercontent.com/mvagnon/zapdev/main/.github/assets/preview.gif" alt="zapdev CLI demonstration">
</p>

---

[![portfolio](https://img.shields.io/website?url=https%3A%2F%2Fmvagnon.dev&up_message=Visit&label=Portfolio&color=%23007fff)](https://mvagnon.dev)
[![bymeacoffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-Support-yellow?logo=buymeacoffee)](https://buymeacoffee.com/mvagnon)

# zapdev

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
| `ZD_URL`          | For `commit` | Complete HTTP(S) Chat Completions endpoint, including its path                                      |
| `ZD_MODEL`        | For `commit` | Model identifier supported by the endpoint                                                          |
| `ZD_EFFORT`       | For `commit` | Sent as `reasoning_effort`; use a value supported by your model, such as `low`, `medium`, or `high` |
| `ZD_HOOK_TIMEOUT` | No           | Deadline per Git hook in seconds (default: `60`); positive numbers from `0.001` to `2147483.647`    |

The LLM settings have no defaults, automatic provider detection, or backup models. CLI flags override these settings. Legacy `OLLAMA_*` variables are no longer read.

Requests use the OpenAI Chat Completions format over plain `fetch`, without a provider SDK. No authentication headers are sent; use an endpoint that does not require them. The endpoint and model must support `reasoning_effort`.

## Setup

### Requirements

- **Node.js >= 20 (required):** runs the CLI.
- **Git (required):** provides the repository operations.
- **OpenAI-compatible Chat Completions endpoint (required for `commit`):** generates Conventional Commit messages.
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

Configure your endpoint and model before running `commit` (replace these example values):

```bash
export ZD_URL="http://localhost:1234/v1/chat/completions"
export ZD_MODEL="your-model-id"
export ZD_EFFORT="low"
```

Or run it once without installing:

```bash
npx zapdev commit
```

### Development Setup

From a clone:

```bash
npm install
npm run zapdev      # build then run the CLI in dev
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test        # vitest
npm run build       # bundle to dist/ with esbuild
```

`npm link` exposes the local `zapdev` binary after `npm run build`.

## Usage

Run `zapdev` or `zapdev commit` to start the commit flow. Both accept the flags below.

### `zapdev commit`

Stages all changes, scans them with Gitleaks when installed, generates Conventional Commit messages, and optionally pushes the commits.

- **Inside a Git repository:** uses that repository only, including when launched from a subdirectory. Does not inspect child repositories.
- **Outside a Git repository:** processes only direct child repositories. No recursive search; `node_modules` is excluded.
- Folders without their own Git repository remain part of the enclosing repository.
- **Unified review:** generates messages in parallel, then presents every message with its repository name and branch. Repositories with pending changes are shown in bold when terminal styling is enabled.
- **Actions:** commit all, commit only a named repository, edit a named repository's message, or cancel. Editing returns to the review menu.

Repositories with no new changes can still send existing commits. Unselected or cancelled changes remain staged; failed or unselected commit drafts are not pushed. The branch is chosen before committing, never when pushing. Push confirmation is asked once, only for repositories with a configured upstream remote; it is omitted when none have one.

```bash
zapdev commit
```

| Flag                | Description                                                                      |
| ------------------- | -------------------------------------------------------------------------------- |
| `--url <url>`       | Override the complete Chat Completions endpoint                                  |
| `--model <model>`   | Override the model                                                               |
| `--effort <effort>` | Override the reasoning effort                                                    |
| `-t, --type <type>` | Force an exact lowercase Conventional Commit type (`feat`, `fix`, `chore`, etc.) |
| `-p, --push`        | Skip push confirmation and push the current branch                               |
| `--pull`           | Pull fast-forward updates in repositories with an upstream remote before staging or message generation |
| `-s, --staged`      | Commit only changes that are already staged                                      |
| `-y, --yes`         | Skip commit review; still confirm push unless `--push` is set                    |

```bash
zapdev commit -t feat      # force the type
zapdev commit --staged     # leave unstaged changes untouched
zapdev commit -y           # commit automatically, then ask before pushing
zapdev commit -yp          # skip review and push confirmation; choose a branch if protected
zapdev commit --pull       # pull first, then follow the normal commit flow
```

Before contacting the LLM endpoint, zapdev runs `gitleaks git --staged --verbose` in each changed repository when Gitleaks is installed. A failed scan skips that repository without sending its diff; when Gitleaks is absent, the scan is skipped. The staged diff is sent to the configured endpoint, which may be remote.

Preparation and commit failures are reported per repository while the others continue. A push failure stops all remaining sends. Any failure produces a nonzero exit code.

With `--pull`, repositories are pulled one at a time before any staging, secret scan, or message generation. Git uses each current branch's configured upstream. Repositories without a configured upstream remote are skipped with a warning, even if they have a single remote. Divergent history, a missing upstream branch, or conflicting local changes stop the entire flow before staging; no rebase, merge commit, or automatic stash is performed. Earlier successful pulls remain applied.

In a terminal, commit, pull, and push output is streamed into Clack task logs; silent commands create no output block. Git keeps terminal input, but stdout/stderr are pipes: hooks requiring a TTY on those streams are not supported. Git controls hook stdin; hooks can read from `/dev/tty`, although prompts written there appear outside the blocks. `--yes` skips commit review, not native prompts. Without a terminal, stdout/stderr are streamed directly. Each hook has a 60-second deadline, including time spent answering prompts; override it with `ZD_HOOK_TIMEOUT=120 zapdev commit`.

Immediately before each selected commit, zapdev asks for a local branch only when the current name exactly matches `main`, `master`, `principal`, `dev`, or `development`, including with `--yes`. The first prompt starts empty; subsequent prompts reuse the previous input across repositories. Press Enter to accept the prefilled name; an empty or cleared input keeps the current branch and leaves the next prompt empty. A different name switches to the existing local branch or creates it from HEAD, without forcing or discarding pending changes. Other branches and repositories with nothing to commit never trigger this prompt. Cancelling stops the remaining commits and all pushes; earlier commits remain local.

Pushes always target a remote branch with the current local branch's name, with no destination input. They use only the current branch's configured upstream remote and run `git push <remote> HEAD:refs/heads/<current-branch>`. Repositories without a configured upstream remote are skipped with a warning, even if they have a single remote. Pushes run directly, without a preliminary fetch or history comparison; Git handles up-to-date branches and rejects non-fast-forward updates. A missing destination branch can be created even without new changes. No rebase, merge, retry, or force-push.

Without a TTY, zapdev commits prepared repositories on nonprotected branches automatically; protected-branch commits are refused and changes remain staged. `--push` can publish without a TTY; without it, commits stay local. Repositories without new changes do not trigger an LLM call, branch prompt, or new commit.

### Zed IDE

For a faster review and commit workflow, review and stage changes from Zed's Git panel, then run `zapdev commit -syp` from a task. The command commits only staged changes, skips commit review and push confirmation, and asks for a branch before committing only if the current branch is protected.

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

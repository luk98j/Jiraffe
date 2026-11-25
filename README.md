# Jiraffe

Jiraffe is a local web app that pulls your Jira tasks onto a board, lets you add local tasks (`LOC-0001`, ...), and keeps a per-task chat and an activity journal. Everything runs on your machine, listens on `127.0.0.1` only, and stores its state in SQLite. Jira is read-only: the app never writes anything back to it.

All seven build steps of `docs/implementation-plan.md` are built: the data model, the task state machine, Jira sync, local tasks, delete/restore/retention, the REST API with live updates (SSE), the board UI, and the agent side (workers and slots, the Copilot CLI adapter, analysis, delegate with git worktrees, quota handling, crash recovery and a Claude Code adapter).

## Agents and execution

- **Start queue.** Analyse moves a task to "New / Queued". Queued tasks are analysed only when `auto_analysis` is on or after you press Start queue on the board, which lets workers start analyses for the current app session (it enqueues nothing). Up to `max_parallel_analysis` analyses and `max_parallel_execution` executions run at once.
- **Analysis.** Two agent runs per task (business analyst, then architect). Each must end with a JSON verdict block; an invalid verdict fails the run. A task is ready only when both say READY with no open questions; otherwise the questions become agent messages and the task waits for you. The result and the permissions the agent asks for are shown in task detail; permissions are display only and never change `allowed_tools`.
- **Delegate.** Enabled only when the task is ready, has no newer messages, its Jira description did not change after the analysis, the task has a `repo_path`, and `allowed_tools` is acceptable. When disabled, the tooltip gives the reason.
- **Worktrees.** Execution runs in a git worktree at `<worktrees_dir>/<KEY>` on branch `task/<KEY>`. Retries reuse it. The app writes `.orchestrator/context.md` there (excluded from git) and never merges, pushes or removes a worktree on its own.
- **Logs, diff, review.** Agent output is stored per line and shown in task detail (capped at 5 MiB per run). When execution ends the task is in review: the diff against the base commit is shown (capped at 1 MiB) and Accept moves the task to done without merging anything. Deleting a task can optionally remove its worktree and branch; if that removal is refused or fails, the task stays deleted and the API answers 200 with `removalError`. Restore brings back only the task record.
- **Pause on quota.** A usage or credit limit pauses the task (`paused_quota`) and frees its slot. It resumes by itself after `quota_retry_minutes` (or the reset time, if known), or you can Resume or Cancel it.
- **Recovery.** At start the app marks unfinished runs as crashed, moves `analysing` tasks back to the queue and `running` tasks back to delegated (execution then restarts in the existing worktree), and does not signal old agent processes.
- **Credentials.** `JIRA_EMAIL` and `JIRA_API_TOKEN` are removed from the environment of agent and git child processes, and exact values are redacted from stored logs.

Agent settings (editable in Settings, defaults from `packages/core/src/settings.ts`):

| Setting | Default | Meaning |
|---|---|---|
| `agent` | `copilot` | `copilot` or `claude`; selects the adapter at run start. |
| `run_timeout_minutes` | `30` | 1 to 1440; a run over this time is killed and ends crashed. |
| `execution_prompt_template` | built-in text | Placeholders `{{task_key}}`, `{{title}}`, `{{body}}`, `{{context}}`; `{{context}}` is required, others are rejected. |

**Real execution is disabled until the CLI flags are confirmed.** The Copilot tool-allowlist flag, the usage-limit messages and the Claude flags are not confirmed (spec section 12), so the code invents none: Delegate stays disabled with the reason "Tool restriction flag is not confirmed", every Claude run fails with "Claude Code adapter is not verified", and `quota_error_patterns` is empty, so no output is classified as a quota error. Analysis with Copilot is not blocked: with `agent = copilot`, Start queue or `auto_analysis` runs the real `copilot` binary, which can spend credits and is told to be read-only only by instruction. Windows is not supported for agent runs (process groups). Check that your Copilot plan allows automating the CLI (spec section 12 item 5).

## Requirements

- Node.js 22 (see `.nvmrc`; later versions have also run the test suite)
- pnpm (the repo pins `packageManager` in `package.json`)
- A C++ toolchain may be needed the first time: `better-sqlite3` is a native module and is built (or downloaded) during `pnpm install`

## Install

```sh
pnpm install
```

Needs network access once. Everything else (build, typecheck, tests) works offline.

## Run

```sh
pnpm dev     # API server on http://127.0.0.1:4317 and the web UI with hot reload (Vite prints its URL, usually http://localhost:5173)
pnpm start   # API server only (http://127.0.0.1:4317/api/health); the server does not serve the UI bundle yet
```

`pnpm dev` is the way to use the UI: Vite proxies `/api` to the server and rewrites the `Host` and `Origin` headers to the server's address (`packages/web/vite.config.ts`).

The API answers `403` to any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, or whose `Origin` (when present) is not `http://127.0.0.1:<port>` or `http://localhost:<port>` (DNS-rebinding guard in `packages/server/src/app.ts`). A reverse proxy or another hostname in front of the server is refused unless it rewrites these headers.

| Setting | How |
|---|---|
| Database file | `./data/jiraffe.db` by default, override with `JIRAFFE_DB_PATH`. The `data/` folder is git-ignored. |
| Server port | `4317` by default, override with `JIRAFFE_PORT`. The host is fixed to `127.0.0.1` and cannot be changed. |

## Checks and formatting

```sh
pnpm test        # Vitest, all packages (no network, no Jira credentials needed)
pnpm typecheck
pnpm build       # builds the web bundle into packages/web/dist
pnpm lint        # Biome recommended lint rules; warnings fail CI
pnpm lint:fix    # apply safe lint fixes
pnpm format:check
pnpm format      # format TypeScript, TSX, JSON, CSS and HTML
pnpm run audit   # fail on high or critical dependency vulnerabilities
```

Tests never reach the network: `fetch` is replaced by a stub that throws, and `JIRA_*` variables are removed from the environment.

GitHub Actions runs lint, formatting checks, `pnpm build`, `pnpm typecheck` and
`pnpm test` for pull requests targeting `main` and pushes to `main`.
The workflow uses Node.js from `.nvmrc`,
pnpm from `package.json`, and a frozen lockfile. It needs no Jira credentials.
You can also start it manually from the Actions tab after it is merged.

Biome uses the existing two-space indentation and single-quoted JavaScript style.
Test assertions may use non-null assertions; the stylesheet retains its intentional
cascade ordering. Other recommended lint rules remain enabled. Generated Drizzle
metadata, dependencies, build output and local data are excluded from formatting.

The Security workflow audits all locked dependencies (including development tools)
and runs CodeQL with extended JavaScript/TypeScript security queries on PRs, pushes
to `main`, and weekly on Mondays. CodeQL publishes findings to GitHub code scanning;
a successful analysis does not mean there are no findings. Secret scanning and
push protection are configured separately in the repository's GitHub settings.

## Connecting Jira (optional, later)

Without configuration the app works with local tasks only and shows "Jira not configured".

1. Create a Jira API token in your Atlassian account.
2. Export the credentials before starting the server (they are read from the environment only and are never stored in the database or logs):

   ```sh
   export JIRA_EMAIL="you@example.com"
   export JIRA_API_TOKEN="..."
   ```

3. In the app, open Settings and set `jira_base_url` (for example `https://your-site.atlassian.net`). The URL must be `https`; `http` is accepted only for `localhost` and `127.0.0.1` (`packages/core/src/settings.ts`). Optionally set `jira_projects`, `jira_ignored_statuses` and `repo_map` (Jira project key to local repository path).

Tasks assigned to you and not in a Done status category are imported at start and then every 30 minutes (`jira_tasks_sync_minutes`); comments of tasks waiting for you or in later states are read every 30 minutes (`jira_comments_sync_minutes`). Both intervals accept 1 to 1440 minutes. Use "Sync now" in Settings to run a task sync immediately.

Settings shows the same credentials instructions: `JIRA_EMAIL` and `JIRA_API_TOKEN` are read from the environment of the server process, must be set before the server starts, and need a server restart after a change. The app has no field for them and never stores them. The page is grouped into five sections (Jira connection, Agent, Usage limits, Repositories and execution, Data retention); each has one "Save <section name>" button that sends only the fields you changed. A field the server rejects shows its message and returns to the stored value, while the other fields of that section are still saved. The Jira sync status panel sits inside the Jira connection section.

**Sync logs and the journal.** Every sync outcome is written to the server console, one line per event, each starting with an ISO 8601 time (for example `2026-11-25T10:15:00.123Z info: Jira task sync started`). A task sync logs when it starts and when it finishes, with the counts, the number of issues Jira returned and the JQL it used, for example `Jira task sync finished: 0 new, 0 updated; Jira returned 0 issues; JQL: assignee = currentUser() AND statusCategory != Done`. Comment syncs log their start and the number of new comments and tasks checked. Failures, a missing `jira_base_url` and skipped runs (another sync still running) are logged too. Log lines carry only a safe message and, for an unexpected error, its class name. They never contain credentials or raw error text.

The same outcomes appear in the Journal as short rows: `sync_run` for a finished sync (also when nothing changed), `sync_failed` with the safe error message, and `sync_skipped` with the reason. The server log gets every run; the Journal gets a row when a sync changed something, or when the outcome text differs from the last journaled outcome of the same kind (task sync or comment sync) since the server started. An identical repeat is not journaled again, so the Journal does not fill up with one row per interval. The Journal view has a Detail column with this text. Unchanged tasks still get no entry (`packages/engine/src/sync.ts`).

The Jira HTTP client targets Jira Cloud and has only been tested against fixtures, not a real instance. Jira Data Center may need small changes in `packages/jira/src/http.ts`.

## Layout

```
packages/
  adapters/ agent runner interface, Copilot and Claude adapters, git helpers, test fakes (the only package that spawns processes)
  core/    state machine, settings schema, shared types (no workspace dependencies)
  db/      Drizzle schema, migrations, data access
  engine/  transition(), event bus, sync, retention, scheduler
  jira/    Jira client interface, HTTP client, JQL builder, test fake
  server/  Fastify REST API and SSE stream
  web/     React + Vite UI
tests/     architecture rules (dependency matrix, only the engine writes task status) and cross-cutting tests
```

Dependency direction: `web` -> `core`; `server` -> `engine` -> `db`, `jira`, `adapters`; every package may use `core`. `tests/architecture.test.ts` enforces this.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The product plan is in [docs/implementation-plan.md](docs/implementation-plan.md).

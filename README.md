# Jiraffe

Jiraffe is a local web app that pulls your Jira tasks onto a board, lets you add local tasks (`LOC-0001`, ...), and keeps a per-task chat and an activity journal. Everything runs on your machine, listens on `127.0.0.1` only, and stores its state in SQLite. Jira is read-only: the app never writes anything back to it.

This is the foundation (steps 1-4 of `docs/implementation-plan.md`): the data model, the task state machine, Jira sync, local tasks, delete/restore/retention, the REST API with live updates (SSE), and the board UI.

**Not built yet (steps 5-7):** analysis workers and queues, the Copilot CLI adapter, git worktrees and execution, quota handling and crash recovery. Pressing Analyse moves a task to "New / Queued" and it stays there. Delegate is shown but always disabled ("Execution is not available yet").

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

The journal is silent when nothing changed: unchanged tasks get no entry, and a sync that created, updated and closed nothing writes no `sync_run` entry (`packages/engine/src/sync.ts`).

The Jira HTTP client targets Jira Cloud and has only been tested against fixtures, not a real instance. Jira Data Center may need small changes in `packages/jira/src/http.ts`.

## Layout

```
packages/
  core/    state machine, settings schema, shared types (no workspace dependencies)
  db/      Drizzle schema, migrations, data access
  engine/  transition(), event bus, sync, retention, scheduler
  jira/    Jira client interface, HTTP client, JQL builder, test fake
  server/  Fastify REST API and SSE stream
  web/     React + Vite UI
tests/     architecture rules (dependency matrix, only the engine writes task status) and cross-cutting tests
```

Dependency direction: `web` -> `core`; `server` -> `engine` -> `db`, `jira`; every package may use `core`. `tests/architecture.test.ts` enforces this.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The product plan is in [docs/implementation-plan.md](docs/implementation-plan.md).

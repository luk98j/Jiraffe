# AGENTS.md

Agreements for every AI agent (and human newcomer) working in this repo. Read it before changing anything. Changing this file needs the owner's approval (see "Ask the owner first").

## What this repo is

Jiraffe is a local web app: a Jira task board with local tasks, per-task chat and a journal. See [README.md](README.md).

- The spec and source of truth is [docs/implementation-plan.md](docs/implementation-plan.md).
- Steps 1-4 of its section 11 (board foundation) are built and merged.
- Steps 5-7 are **not built** and are separate work: workers and slots, Copilot CLI adapter, delegate and worktrees, `allowed_tools` enforcement, quota handling, `onBoot` recovery, Claude Code adapter. Do not start them as a side effect of another task.

| Package | Owns |
|---|---|
| `packages/adapters` | agent runner interface, Copilot CLI adapter, test fakes; the only package that spawns processes |
| `packages/core` | state machine, settings schema, shared types; no workspace dependencies |
| `packages/db` | Drizzle schema, migrations, data access, the status writer |
| `packages/engine` | `transition()`, event bus, sync, retention, scheduler |
| `packages/jira` | Jira client interface, HTTP client, JQL builder, test fake |
| `packages/server` | Fastify REST API and SSE stream |
| `packages/web` | React + Vite UI |

`tests/` holds the architecture rules and cross-cutting tests.

## Commands

From `package.json` scripts and the README:

```sh
pnpm install
pnpm dev         # API server on 127.0.0.1:4317 plus the web UI with hot reload
pnpm start       # API server only
pnpm build
pnpm typecheck
pnpm test
```

Run `pnpm build`, `pnpm typecheck` and `pnpm test` before handing work over, and say in the PR if you could not.

## Architecture rules (enforced by `tests/architecture.test.ts`)

- Allowed workspace dependencies: `adapters` -> `core`; `db` -> `core`; `jira` -> `core`; `engine` -> `core`, `db`, `jira`, `adapters`; `server` -> `core`, `engine`; `web` -> `core`; `core` -> nothing. No relative import may leave its package.
- Only `db` imports `drizzle-orm` and `better-sqlite3`; only `adapters` imports `node:child_process`; only `server` imports `fastify`; only `web` imports `react` and `react-dom`.
- Only the engine changes `tasks.status`: `@jiraffe/db/status-writer` (`packages/db/src/taskStatus.ts`, exporting `insertTask` and `applyStatusChange`) is imported only by `packages/engine/src/transition.ts` and `createTask.ts`. No `UPDATE tasks`, `insert(tasks)` or `.set({ status ... })` elsewhere.
- Do not weaken or bypass these tests. If a rule is in the way, ask the owner.

## Git and PRs

- Never push to or force-push `main`. Work on a branch `<type>/<short-slug>` (for example `docs/contributing-guide`).
- Commits and PR titles use Conventional Commits: `feat`, `fix`, `docs`, `chore`, `refactor`, `test` (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- Small, focused PRs: one concern per PR.
- Open a PR and let the owner merge it. Never merge your own PR.
- `.github/CODEOWNERS` makes `@luk98j` the owner of every file, so every change needs the owner's approval. Per PR #2, a ruleset on `main` also requires code owner review (not verified from files).
- End commit messages and PR descriptions with the attribution lines your session provides.

## Security and data

- The server binds to `127.0.0.1` only (`packages/server/src/config.ts`) and answers 403 to a foreign `Host` or `Origin` (`packages/server/src/app.ts`). Keep both.
- Never commit secrets, tokens, `.env*` files, databases or `data/`.
- Jira credentials come only from the environment: `JIRA_EMAIL` and `JIRA_API_TOKEN`. Never write them to the database, events, journal or logs.
- The app never writes to Jira and never runs `git push`.
- `--yolo` is never used or enabled (spec section 10).
- Screenshots go in a PR description only. Never commit them.

## Language and scope

- Everything is in English: code, comments, UI text, commits. A test fails on Polish diacritics in project files.
- Keep changes surgical. Do not refactor or "improve" unrelated code; mention unrelated problems in the PR instead.
- New behaviour follows the spec. If you deviate, say so in the PR description under "Deviations".

## Local working files

`runs/` (per-run state and reports) and `memory/` (run records) are local orchestration files. They are git-ignored; never commit them or reference them from code or docs. If they exist, read `memory/INDEX.md` for earlier decisions. The current request and the spec win over them.

## Ask the owner first

Do not decide alone. Ask before:

- changing `AGENTS.md`, `CODEOWNERS` or other owner agreements;
- reversing a recorded decision;
- anything with a cost, a new paid service, or a new external dependency on a provider;
- deployment or security-relevant changes.

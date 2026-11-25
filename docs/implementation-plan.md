# Implementation spec: local Jira → Copilot CLI task board

Nov 21, 2026 · @Lukasz Jankowski

A local web app that pulls Jira tasks, gates them through an agent analysis, and runs approved tasks with Copilot CLI in isolated git worktrees. This spec supersedes the earlier Polish draft.

## 1. Goals and scope

**MVP goals**

1. Run tasks locally on the user's own repositories, each in its own git worktree.
2. Gate every task through an agent analysis: a task cannot be delegated until the analysis returns `READY`.

**In scope:** pulling Jira tasks, manual local tasks (`LOC-xxxx`), per-task chat, analysis queue, Delegate button with an execution queue, local delete with 4-week retention, app-wide activity journal.

**Out of scope (MVP):** automatic merge, `git push`, multiple users, cloud hosting, writing anything back to Jira.

**Language rule:** the whole application is in English: UI text, state labels, journal entries, agent prompts, code identifiers, database values, comments and logs.

**Assumptions**

- GitHub Copilot CLI is the primary agent. Claude Code is a second implementation of the same `AgentRunner` interface, added after the MVP.
- Loop and runaway-agent protection belongs to the user's existing orchestrator, not to this app. This app keeps only `max_credits` per run as a backup brake.
- Everything runs locally and listens on `127.0.0.1` only. State lives in SQLite.
- No CLI flag is assumed. Every flag marked in section 12 must be checked with `copilot --help` before use.

## 2. Architecture

TypeScript monorepo (pnpm workspaces), one Node process, SQLite in WAL mode.

```
packages/
  core/      types, transitions.ts (pure state machine), settings schema
  db/        Drizzle schema, migrations, data access
  engine/    transition(), event bus, workers, slots, onBoot, retention job
  adapters/  AgentRunner interface, copilot-cli (primary), claude-code (later)
  jira/      REST client, sync jobs
  server/    Fastify, REST endpoints, SSE stream
  web/       React + Vite UI
```

**Dependency rules**

- Allowed direction: `web` → `server` → `engine` → `db`, `adapters`, `jira`. `core` depends on nothing.
- Only `engine` changes task status. `web`, `adapters` and `jira` never write `tasks.status` directly.
- `core/transitions.ts` has no database access, so it can be unit-tested without SQLite.
- Stack: Fastify, Drizzle ORM with `better-sqlite3`, React with Vite and TanStack Query, SSE for live updates.

## 3. Data model

| Table | Columns | Purpose |
| --- | --- | --- |
| `tasks` | id, source (`jira` or `local`), jira\_key (unique, nullable), local\_key (unique, nullable), title, body, repo\_path, status, status\_before\_pause, priority, max\_credits, pause\_reason, resume\_at, jira\_closed (bool), body\_changed\_after\_analysis (bool), last\_synced\_at, closed\_in\_jira\_at, deleted\_at, created\_at, updated\_at | One row per task |
| `messages` | id, task\_id, role (`user` or `agent`), source (`app` or `jira`), content, jira\_comment\_id (nullable, unique per task), created\_at | Per-task chat and synced Jira comments |
| `runs` | id, task\_id, kind (`analysis` or `execution`), agent, session\_id, status, pid, max\_credits, credits\_used, end\_reason, started\_at, finished\_at | One agent invocation |
| `events` | id, task\_id, type, payload\_json, processed\_at, created\_at | Machine event log that drives the engine |
| `journal` | id, at, task\_key (nullable), status (nullable), action, detail (nullable) | Human-readable app-wide activity log. No foreign key, so entries survive task purge |
| `ignored_jira_keys` | jira\_key (PK), deleted\_at | Tombstones for purged Jira tasks |
| `settings` | key (PK), value\_json | All configuration |

**Notes**

- `runs.end_reason`: `completed`, `credit_limit`, `quota`, `crashed`, `cancelled`.
- `tasks.jira_key` is never reused. A task has exactly one of `jira_key` or `local_key`.
- All timestamps are ISO 8601 UTC strings.
- Use SQLite WAL mode. `engine` is the only writer.

## 4. State machine

The table below is the complete list of allowed transitions. Any other combination must throw. `transition(taskId, event)` runs in one database transaction that updates `tasks`, inserts into `events` and inserts into `journal`.

| From | Event | To |
| --- | --- | --- |
| `new` | `enqueue` | `queued_analysis` |
| `queued_analysis` | `analysis_started` | `analysing` |
| `analysing` | `analysis_ready` | `ready_to_delegate` |
| `analysing` | `analysis_needs_info` | `waiting_user` |
| `analysing` | `quota` | `paused_quota` |
| `analysing` | `failed` | `failed` |
| `waiting_user` | `user_answered` | `queued_analysis` |
| `ready_to_delegate` | `reanalyse` | `queued_analysis` |
| `ready_to_delegate` | `delegate` | `delegated` |
| `delegated` | `execution_started` | `running` |
| `running` | `execution_done` | `review` |
| `running` | `credit_limit` or `quota` | `paused_quota` |
| `running` | `failed` | `failed` |
| `paused_quota` | `resume` | value of `status_before_pause` |
| `review` | `review_accepted` | `done` |
| `review` | `failed` | `failed` |
| `failed` | `retry` | `queued_analysis` |
| any non-terminal | `cancel` | `cancelled` |

**Rules**

- Terminal states: `done`, `cancelled`. Deletion is not a status. It sets `deleted_at` and works from any state except `running` (cancel first).
- Entering `paused_quota` stores the previous status in `status_before_pause`. `resume` restores it and clears `pause_reason` and `resume_at`.
- A user comment while the task is `waiting_user` fires `user_answered`. In other states a comment only adds a message and a UI marker. It never starts an analysis or a delegation.
- `transition()` must be idempotent for repeated delivery of the same event: return without change if the task is already in the target state.

## 5. Engine: events, workers, boot

The agent never listens to the database. The engine decides when to start an agent run.

**Events**

1. `transition()` writes the status change, an `events` row and a `journal` row in one transaction.
2. After commit, the engine emits the event on an in-process `EventEmitter`. Workers react immediately.
3. Every 1–2 seconds a poller reads `events` where `processed_at IS NULL` as a safety net.
4. `dispatch` is idempotent. It sets `processed_at` and checks it before starting a run.
5. Never start an agent process inside a transaction. Commit first, then spawn.
6. Every run stores its result in `runs` before the task status changes.

**Workers and slots**

- Analysis queue: `max_parallel_analysis` (default 2). Execution queue: `max_parallel_execution` (default 2).
- Claiming a task is atomic: `UPDATE tasks SET status='analysing' WHERE id=(SELECT id FROM tasks WHERE status='queued_analysis' AND deleted_at IS NULL ORDER BY priority, updated_at LIMIT 1) RETURNING id`.
- A slot is released as soon as the agent finishes or asks a question. An analysis never waits for the user.
- Tasks in `paused_quota` with `resume_at <= now` are resumed by a worker.

**Boot (`onBoot`)**

1. Mark runs with status `running` as `crashed` (`end_reason = 'crashed'`).
2. Move `analysing` tasks back to `queued_analysis`. Move `running` tasks back to `delegated` and show a UI warning that execution restarts in the worktree.
3. Replay unprocessed `events`.
4. Start a Jira task sync (section 6). Start no agent unless `auto_analysis` is `true`.
5. Run the retention job (section 7).

Starting the app never consumes credits by itself. Analysis starts only when `auto_analysis` is on or the user presses “Start queue”.

## 6. Jira sync and local tasks

Jira is polled. The app is local and has no public address, so webhooks are not used. Jira is read-only for this app.

| Job | When | What it does |
| --- | --- | --- |
| Task sync | on app start, then every 30 min (`jira_tasks_sync_minutes`) | Pulls tasks per the filter below |
| Comment sync | every 30 min (`jira_comments_sync_minutes`) | Only for Jira tasks in `waiting_user`, `ready_to_delegate`, `running`, `paused_quota`. New comments become `messages` with `source = jira` |
| App comments | immediately | Saved as `messages` with `source = app`, event `user_comment` |

**Task filter**

- JQL: `assignee = currentUser() AND statusCategory != Done`, plus `AND status NOT IN (...)` built from the `jira_ignored_statuses` setting. Optionally limited to `jira_projects`.
- Skip a Jira task if its `jira_key` exists in `tasks` (including rows with `deleted_at`) or in `ignored_jira_keys`. A task already on the board, deleted, or purged is never pulled again.
- Changing `jira_ignored_statuses` takes effect on the next sync. It does not remove tasks already on the board.
- New tasks start as `new`. Repository mapping: map the Jira project key to a local path from `repo_map` in settings. If no mapping exists, the task waits for the user to choose a repository and cannot be analysed until one is set.

**Updating a task from Jira**

- On each sync, compare `title` and `body` with the local copy and update them. Status, messages and analysis results are never overwritten.
- If `body` changed after the last analysis finished, set `body_changed_after_analysis`. The UI shows “Description changed in Jira” and Delegate is blocked until the user re-runs the analysis.
- A task in `running` is never interrupted. The change applies to the next run.
- If a board task becomes Done or enters an ignored status in Jira, set `jira_closed = true` and `closed_in_jira_at`. The UI shows a “Closed in Jira” badge. The task is purged automatically 4 weeks after `closed_in_jira_at` (section 7).

**Local tasks**

- The user adds a task with title, description and repository (required). The app assigns `LOC-0001`, `LOC-0002`, and so on from the `local_task_counter` setting, incremented atomically in the same transaction. Numbers are never reused.
- A local task has `source = local`, no `jira_key`, and follows the same flow and analysis gate as Jira tasks. It has no Jira comment sync.

## 7. Deletion, retention and the activity journal

**Deletion**

- Deleting removes a task from the local board only. Nothing is ever changed in Jira.
- Delete is a soft delete: set `deleted_at`. A task in `running` must be cancelled first. The delete dialog asks whether to also remove the worktree and the `task/<KEY>` branch. Default: keep them.
- A “Deleted” view lists soft-deleted tasks from the last 4 weeks and offers Restore (clears `deleted_at`).

**Retention (4 weeks)**

- Setting `retention_days`, default 28. A job runs on app start and then daily.
- It purges tasks where `deleted_at` is older than `retention_days`, and Jira tasks where `closed_in_jira_at` is older than `retention_days`. Purge deletes the task row and its `messages`, `runs` and `events`.
- For a purged Jira task, first insert its key into `ignored_jira_keys`, so the sync never pulls it again. Journal entries are kept.

**Activity journal**

A small app-wide log. Each row has the task number, the task status after the action, and the date. Every one-off action adds one row. It is written inside `transition()` and by the other services in the same transaction as the action.

| Action | Task key | Status | Example detail |
| --- | --- | --- | --- |
| `app_started` | none | none | version |
| `sync_run` | none | none | `3 new, 2 updated; Jira returned 5 issues` (task sync) or `comments: 2 new` (comment sync) |
| `sync_failed` | none | none | safe error message of a failed sync |
| `sync_skipped` | none | none | `Jira not configured: jira_base_url is empty` or `another sync is running` |
| `task_imported` | PROJ-123 | `new` | from Jira |
| `task_created` | LOC-0004 | `new` | manual |
| `task_updated_from_jira` | PROJ-123 | current | title, body |
| `status_changed` | PROJ-123 | new status | `analysing` to `ready_to_delegate` |
| `comment_added` | PROJ-123 | current | source: app or jira |
| `task_deleted`, `task_restored`, `task_purged` | key | current |  |
| `closed_in_jira` | PROJ-123 | current |  |
| `settings_changed` | none | none | key name only, never values |

- The journal is append-only. It is never purged with tasks. Setting `journal_retention_days` is empty by default (keep forever).
- Never write secrets, comment text or task descriptions into `detail`.

## 8. Agents and Copilot CLI

**AgentRunner interface.** `start(prompt, cwd, options) -> run handle`, `stream events`, `cancel()`, `resume(sessionId)` if the CLI supports it. The `copilot-cli` adapter spawns `copilot` as a child process. Every spawn has a timeout. On timeout the process is killed and the run ends with `end_reason = 'crashed'`.

**Confirmed in the documentation:** non-interactive mode `copilot -p "<prompt>"`, per-run credit limit `--max-ai-credits <n>` (the run ends when the limit is reached), custom agents with `--agent=<name>` from `.github/agents/`, `--model=<name>`.

**Analysis (two agents, in order)**

1. Business analyst: acceptance criteria, edge cases, audience, scope gaps.
2. Architect: impact on existing code, dependencies, non-functional requirements, risks.

Each agent receives the task, the message history (marked app or Jira) and prior answers. Each ends its answer with this JSON block:

```json
{
  "verdict": "READY | NEEDS_INFO",
  "questions": ["..."],
  "missing": ["acceptance criteria"],
  "permissions": ["read: src/billing/**", "write: src/billing/**", "run: gradle test"],
  "summary": "one sentence"
}
```

- The result is `READY` only if both agents return `READY` with empty `questions` and `missing`.
- `NEEDS_INFO`: questions are saved as `messages` with `role = agent`, and the task goes to `waiting_user`.
- `permissions` is shown on the Delegate screen. It is not applied automatically.
- Invalid JSON means the run fails. Never guess a verdict.

**Execution (after Delegate)**

1. `canDelegate()` checks: status is `ready_to_delegate`; no newer user message than the last analysis; `body_changed_after_analysis` is false; an execution slot is free or the task can queue; `allowed_tools` is valid. Each failure returns a readable reason for the UI.
2. Create a worktree: `git worktree add <worktrees_dir>/<KEY> -b task/<KEY>` in `repo_path`.
3. Write `.orchestrator/context.md` in the worktree (status, analysis verdict, new comments with source, permissions). Add it to `.git/info/exclude`.
4. Run `copilot -p` with the user's orchestrator prompt template, including the same context snapshot.
5. Stream stdout and stderr to the UI and to `events`. On completion the task goes to `review` with a diff against the base branch.
6. Accepting the review ends the task. There is no automatic merge and no push.

Copilot in `-p` mode cannot receive messages mid-run. A comment that arrives during a run is stored, marked “waits for next run”, and used in the next run. A new run starts only when the state machine requires it.

## 9. UI

All UI text is in English. The main screen is a board with columns in flow order. Tasks that need the user are highlighted and counted in the column header.

| Status | Label | Color | Card actions |
| --- | --- | --- | --- |
| `new`, `queued_analysis` | New / Queued | grey | Analyse, Delete |
| `analysing` | Analysing | blue, animated | Cancel |
| `waiting_user` | Waiting for you | orange, highlighted | Answer, Delete |
| `ready_to_delegate` | Ready to delegate | green | Delegate, Re-analyse, Delete |
| `delegated` | Queued for execution | blue | Cancel |
| `running` | Running | blue, animated | Logs, Cancel |
| `paused_quota` | Paused (usage limit) | yellow | Resume, Cancel |
| `review` | Needs review | purple, highlighted | Show diff, Accept |
| `done` | Done | dark green, dimmed | Delete |
| `failed` | Failed | red, highlighted | Show error, Retry, Delete |
| `cancelled` | Cancelled | grey | Delete |

**Rules**

- A state is always shown with color, text and an icon, never color alone.
- A card shows the key (`PROJ-123` or `LOC-0001`), title, repository, and a source badge (Jira or Local).
- Badges: “New comment”, “Description changed in Jira”, “Closed in Jira”.
- Delegate is disabled with a tooltip carrying the reason returned by `canDelegate()`.
- “Add task” is always visible above the board. A filter hides `done` and `cancelled`.
- Views: Board, Task detail (chat, analysis result, logs, diff), Deleted (last 4 weeks, with Restore), Journal, Settings.
- Journal view: a table of date, task key, status, action and detail, newest first, with filters by task key and by action.
- State changes reach the UI over SSE without a page refresh.

## 10. Settings and security

All settings live in the `settings` table, are editable in the UI, and need no rebuild.

| Key | Default | Meaning |
| --- | --- | --- |
| `auto_analysis` | `false` | Start analysis automatically on boot |
| `max_parallel_analysis` | `2` | Analysis slots |
| `max_parallel_execution` | `2` | Execution slots |
| `default_max_credits` | `2.0` | Backup per-run limit (`--max-ai-credits`) |
| `quota_retry_minutes` | `60` | Retry delay when the reset time is unknown |
| `quota_error_patterns` | empty list | Patterns that classify a usage-limit error |
| `jira_base_url`, `jira_projects` | empty | Jira connection and project filter |
| `jira_ignored_statuses` | empty list | Statuses never pulled from Jira |
| `jira_tasks_sync_minutes` | `30` | Task sync interval |
| `jira_comments_sync_minutes` | `30` | Comment sync interval |
| `repo_map` | empty | Jira project key to local repository path |
| `worktrees_dir` | `../.worktrees` | Where worktrees are created |
| `allowed_tools` | see below | Allowlist for execution |
| `retention_days` | `28` | Deleted and closed-in-Jira task retention |
| `journal_retention_days` | empty | Keep journal forever when empty |
| `local_task_counter` | `0` | Last used `LOC` number |

The Settings view groups the keys into five sections: Jira connection (with the Jira sync panel and a note that `JIRA_EMAIL` and `JIRA_API_TOKEN` come from the server environment), Agent, Usage limits, Repositories and execution, and Data retention. Each section has one Save button that sends one `PUT /api/settings/:key` per edited key.

**Security**

- Default `allowed_tools`: `git status`, `git diff`, `git add`, `git commit`, `gradle test`. This list is the only source of permissions for execution.
- `--yolo` is blocked in code. No setting enables it. `--autopilot` is not used without an allowlist.
- No `git push` and no writes outside the worktree. Check every path against the worktree directory.
- Store the Jira token and API keys in environment variables or the OS secret store. Never write them to the database, `events`, `journal` or logs.
- The server listens on `127.0.0.1` only.

## 11. Tests and build order

**Build order**

1. Monorepo skeleton, `db` schema and migrations, settings seed.
2. `core/transitions.ts` and `transition()` with events and journal, with unit tests.
3. Jira sync: filter, updates, ignore rules, local tasks, delete and retention.
4. Board UI with state labels, task detail with chat, Journal and Deleted views.
5. Workers, slots and the Copilot adapter: analysis with the verdict contract.
6. Delegate, worktrees and execution with logs and review.
7. Quota handling, `onBoot` recovery. Claude Code adapter only after that.

**Status:** steps 1-7 are built. Known deviations of steps 5-7 from this spec:

- D1. Three settings were added to section 10: `run_timeout_minutes` (1 to 1440, default 30), `execution_prompt_template` (fixed placeholders `{{task_key}}`, `{{title}}`, `{{body}}`, `{{context}}`, `{{context}}` required) and `agent` (`copilot` or `claude`, default `copilot`).
- D2. `runs.status` is `running` or `finished`; `runs` gained `result_json`, `worktree_path`, `branch` and `base_commit`.
- D3. New endpoints: `POST /api/queue/start`, `GET /api/queue`, `POST /api/tasks/:id/delegate` (409 with the reason when blocked), `GET /api/tasks/:id/logs?after=&limit=` (returns `lines`, `truncated`, `hasMore`), `GET /api/tasks/:id/diff`, and `DELETE /api/tasks/:id?removeWorktree=1` (also removes that task's worktree and branch; answers 204 normally, but when the worktree or branch removal is refused or fails, for example because the branch was not created by Jiraffe or the agent is still stopping, it answers 200 with `{removalError}` and the task stays deleted). The generic events endpoint still accepts UI events only.
- D4. The worker claim goes through `transition()` (`analysis_started`) instead of the raw SQL in section 5.
- D5. Recovery moves outside the section 4 table: `analysing -> queued_analysis` and `running -> delegated`, made only at boot by `recoverTask` in `packages/engine/src/transition.ts`, with event types `recovered_to_queued_analysis` and `recovered_to_delegated`. Three more non-transition event types exist: `agent_output`, `log_truncated`, `run_error`.
- D6. Empty, failed and skipped syncs are now journaled (section 7). A sync with no changes writes a `sync_run` row, and two new actions exist: `sync_failed` and `sync_skipped`. A row is written when the sync changed something, or when its `<action>: <detail>` text differs from the last journaled one of the same kind (task or comment sync) in this process; the memory is in RAM, so the first outcome after a start is always journaled, and it is updated only after the row is committed. A failing journal write is logged and never changes the sync outcome. The task-sync `sync_run` detail gained `; Jira returned N issues`. The engine `Logger` gained an `info` level, and every sync writes start, finish (with the JQL for task sync), failure, not-configured and skipped lines to the server log.
- D7. The Journal view (section 9) gained a Detail column.
- D8. Settings (section 10) is grouped into five sections with one Save per section and a static credentials help text; the API is unchanged, so a section Save sends one `PUT` per edited key and can be partly saved. The Jira sync panel moved inside the Jira connection section.
- D9. The default server logger prefixes every line with an ISO 8601 timestamp and the level. Sync failures log the safe message plus the error class name, never the raw error, so credentials cannot reach the log through an error text.
- X1. `delegated -> failed` is not in section 4. When execution cannot start (repo missing, git error, bad path, unverified adapter), one transaction applies `execution_started` and then `failed`, so the task is never seen as running but the journal shows both moves.
- X3 to X5. `runs.agent` holds the adapter id and the analyst or architect role is in `result_json`; the architect run is skipped when the analyst does not return a clean READY; a credit limit during analysis uses the `quota` event.
- Environment stripping. `JIRA_EMAIL` and `JIRA_API_TOKEN` are removed from the environment of agent and git child processes (`packages/adapters/src/spawner.ts`), and their exact values are redacted from stored logs.
- Stale pids found at boot are not signalled; a leftover agent from a crashed app run can keep running.
- Real analysis with Copilot is not fail-closed. Only execution (and every Claude run) is refused until section 12 is resolved.

**Acceptance tests**

- [ ] Every allowed transition works. Every other combination throws.
- [ ] Every transition writes one `events` row and one `journal` row in the same transaction.
- [ ] Two parallel workers never claim the same task.
- [ ] `max_parallel_analysis = 2` allows only two active analysis runs.
- [ ] Starting the app with `auto_analysis = false` starts no run.
- [ ] Invalid verdict JSON ends the run as failed, never as `READY`.
- [ ] A task already on the board, soft-deleted, or purged is not pulled again. Run the sync twice.
- [ ] Done and ignored-status Jira tasks are not pulled. Changing `jira_ignored_statuses` changes the next sync.
- [ ] A changed Jira description after analysis blocks Delegate until re-analysis.
- [ ] `LOC-` numbers are sequential and never reused after delete or purge.
- [ ] Retention purges at 28 days, keeps the journal, and keeps the key in `ignored_jira_keys`.
- [ ] A command outside `allowed_tools` is not executed.
- [ ] Manual test with real `copilot` on a test repository with two tasks in parallel.

## 12. Open items to verify before coding

Check each in `copilot --help` or the documentation and record the result here. Status after steps 5-7 (the `copilot` and `claude` binaries were not available when they were built, so nothing below was run against a real CLI):

1. Flag or setting that restricts tools (the allowlist) in `-p` mode, and its exact syntax. **Open.** The capability profile in `packages/adapters/src/copilot.ts` has the `allowTool` entry marked unverified with no flag text. Execution fails closed: `canDelegate()` is false with "Tool restriction flag is not confirmed (spec section 12 item 1)". `allowed_tools` entries containing a `git push`, `--yolo` or blanket-allow form are rejected even after the flag is confirmed.
2. How to resume a session by `session_id` in non-interactive mode. **Open.** The `resume` entry is unverified and unused; a resumed or recovered task starts a fresh run.
3. Exit code and message format when `--max-ai-credits` or a weekly or monthly usage limit is reached. **Open.** `quota_error_patterns` is empty by default (nothing is classified as quota), the exit-code rule is disabled, and `credits_used` and the reset time are not parsed. Without a reset time, `resume_at` is now plus `quota_retry_minutes`.
4. Whether `@github/copilot-sdk` (public preview) gives better session control than spawning the CLI. **Decided:** the CLI is spawned behind the `AgentRunner` interface; no SDK dependency.
5. Whether your Copilot plan and terms allow automating the CLI. **Open, owner only.**
6. Jira: `statusCategory`, status names and auth method. **Handled in step 3** (API token; the HTTP client is tested against fixtures only).
7. Delete-and-restore of a task whose worktree was removed. **Verified in tests and implemented:** restore brings back only the task record; the worktree and branch are removed only when the delete request asks for it.

Confirmed in the documentation and used by the adapter: `-p`, `--max-ai-credits`, `--agent=` and `--model=`. Claude Code: every capability entry in `packages/adapters/src/claude.ts` is unverified, so Claude runs end with "Claude Code adapter is not verified" until the owner confirms the flags.

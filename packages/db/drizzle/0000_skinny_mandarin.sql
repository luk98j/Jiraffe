CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text,
	`processed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_task_idx` ON `events` (`task_id`);--> statement-breakpoint
CREATE INDEX `events_processed_idx` ON `events` (`processed_at`);--> statement-breakpoint
CREATE TABLE `ignored_jira_keys` (
	`jira_key` text PRIMARY KEY NOT NULL,
	`deleted_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`task_key` text,
	`status` text,
	`action` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `journal_at_idx` ON `journal` (`at`);--> statement-breakpoint
CREATE INDEX `journal_task_key_idx` ON `journal` (`task_key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`content` text NOT NULL,
	`jira_comment_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_task_comment` ON `messages` (`task_id`,`jira_comment_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`kind` text NOT NULL,
	`agent` text,
	`session_id` text,
	`status` text,
	`pid` integer,
	`max_credits` real,
	`credits_used` real,
	`end_reason` text,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`jira_key` text,
	`local_key` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`repo_path` text,
	`status` text NOT NULL,
	`status_before_pause` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`max_credits` real,
	`pause_reason` text,
	`resume_at` text,
	`jira_closed` integer DEFAULT false NOT NULL,
	`body_changed_after_analysis` integer DEFAULT false NOT NULL,
	`last_synced_at` text,
	`closed_in_jira_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "tasks_one_key" CHECK(("tasks"."jira_key" IS NULL) <> ("tasks"."local_key" IS NULL)),
	CONSTRAINT "tasks_source" CHECK(source IN ('jira', 'local')),
	CONSTRAINT "tasks_status" CHECK(status IN ('new', 'queued_analysis', 'analysing', 'waiting_user', 'ready_to_delegate', 'delegated', 'running', 'paused_quota', 'review', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_jira_key_unique` ON `tasks` (`jira_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_local_key_unique` ON `tasks` (`local_key`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_deleted_at_idx` ON `tasks` (`deleted_at`);
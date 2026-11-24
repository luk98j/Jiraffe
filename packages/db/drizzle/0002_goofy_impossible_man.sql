ALTER TABLE `runs` ADD `branch_created` integer;--> statement-breakpoint
CREATE INDEX `runs_task_kind_idx` ON `runs` (`task_id`,`kind`);--> statement-breakpoint
CREATE INDEX `runs_kind_finished_idx` ON `runs` (`kind`,`finished_at`);--> statement-breakpoint
CREATE INDEX `events_task_type_idx` ON `events` (`task_id`,`type`,`id`);
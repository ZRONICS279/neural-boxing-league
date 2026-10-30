CREATE TABLE `training_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`target_id` text NOT NULL,
	`league_json` text NOT NULL,
	`remaining_cycles` integer,
	`cycles` integer DEFAULT 0 NOT NULL,
	`bouts` integer DEFAULT 0 NOT NULL,
	`physics_steps` integer DEFAULT 0 NOT NULL,
	`candidates` integer DEFAULT 0 NOT NULL,
	`checkpoints` integer DEFAULT 0 NOT NULL,
	`start_fitness` real DEFAULT 0 NOT NULL,
	`current_fitness` real DEFAULT 0 NOT NULL,
	`reward_gain` real DEFAULT 0 NOT NULL,
	`pause_requested` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

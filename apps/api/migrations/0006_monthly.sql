CREATE TABLE `monthly_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`amount_msat` integer NOT NULL,
	`tip_percent` integer NOT NULL,
	`status` text DEFAULT 'charging' NOT NULL,
	`reason` text,
	`sprinkle_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`notified_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`plan_id`) REFERENCES `monthly_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sprinkle_id`) REFERENCES `sprinkles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "monthly_cycles_status_check" CHECK("monthly_cycles"."status" IN ('charging', 'needs_payment', 'paid', 'missed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_cycles_plan_due_idx` ON `monthly_cycles` (`plan_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `monthly_cycles_status_idx` ON `monthly_cycles` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `monthly_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`amount_msat` integer NOT NULL,
	`projects_min` integer NOT NULL,
	`projects_max` integer NOT NULL,
	`exclude_funded` integer DEFAULT true NOT NULL,
	`tip_percent` integer DEFAULT 0 NOT NULL,
	`supporter_name` text,
	`comment` text,
	`nwc_sealed` text,
	`nwc_label` text,
	`status` text DEFAULT 'active' NOT NULL,
	`billing_day` integer NOT NULL,
	`next_charge_at` integer NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`email_token_hash` text,
	`email_token_expires_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "monthly_plans_status_check" CHECK("monthly_plans"."status" IN ('active', 'paused'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_plans_creator_id_unique` ON `monthly_plans` (`creator_id`);--> statement-breakpoint
CREATE INDEX `monthly_plans_due_idx` ON `monthly_plans` (`status`,`next_charge_at`);--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `shares_msat` text;
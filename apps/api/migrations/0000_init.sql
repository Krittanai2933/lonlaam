CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`poll_token_hash` text,
	`linking_key` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "auth_challenges_kind_check" CHECK("auth_challenges"."kind" IN ('nostr', 'lnurl'))
);
--> statement-breakpoint
CREATE INDEX `auth_challenges_expires_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `creators` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text,
	`display_name` text,
	`lightning_address` text,
	`npub` text,
	`nostr_pubkey` text,
	`lnurl_auth_key` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `creators_handle_unique` ON `creators` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `creators_nostr_pubkey_unique` ON `creators` (`nostr_pubkey`);--> statement-breakpoint
CREATE UNIQUE INDEX `creators_lnurl_auth_key_unique` ON `creators` (`lnurl_auth_key`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`amount_msat` integer NOT NULL,
	`supporter_name` text,
	`comment` text,
	`bolt11` text NOT NULL,
	`payment_hash` text NOT NULL,
	`verify_url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`preimage` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invoices_status_check" CHECK("invoices"."status" IN ('pending', 'paid', 'expired')),
	CONSTRAINT "invoices_amount_check" CHECK("invoices"."amount_msat" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_payment_hash_unique` ON `invoices` (`payment_hash`);--> statement-breakpoint
CREATE INDEX `invoices_project_status_paid_idx` ON `invoices` (`project_id`,`status`,`paid_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`cover_key` text,
	`category` text,
	`goal_sats` integer,
	`milestones` text DEFAULT '[]' NOT NULL,
	`ends_at` integer,
	`raised_msat` integer DEFAULT 0 NOT NULL,
	`supporter_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "projects_status_check" CHECK("projects"."status" IN ('draft', 'active', 'closed')),
	CONSTRAINT "projects_category_check" CHECK("projects"."category" IS NULL OR "projects"."category" IN ('edu', 'media', 'tech', 'community', 'art'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `projects_creator_idx` ON `projects` (`creator_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `creators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_creator_idx` ON `sessions` (`creator_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);
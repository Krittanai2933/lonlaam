CREATE TABLE `sprinkle_payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`sprinkle_id` text NOT NULL,
	`project_id` text NOT NULL,
	`invoice_id` text,
	`amount_msat` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`sprinkle_id`) REFERENCES `sprinkles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sprinkle_payouts_status_check" CHECK("sprinkle_payouts"."status" IN ('pending', 'paying', 'paid', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `sprinkle_payouts_sprinkle_idx` ON `sprinkle_payouts` (`sprinkle_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sprinkles` (
	`id` text PRIMARY KEY NOT NULL,
	`amount_msat` integer NOT NULL,
	`project_count` integer NOT NULL,
	`per_project_msat` integer NOT NULL,
	`supporter_name` text,
	`comment` text,
	`bolt11` text NOT NULL,
	`payment_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`completed_at` integer,
	CONSTRAINT "sprinkles_status_check" CHECK("sprinkles"."status" IN ('pending', 'distributing', 'done', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sprinkles_payment_hash_unique` ON `sprinkles` (`payment_hash`);--> statement-breakpoint
CREATE INDEX `sprinkles_status_idx` ON `sprinkles` (`status`,`created_at`);
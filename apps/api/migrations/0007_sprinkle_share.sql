ALTER TABLE `sprinkles` ADD `share_msat` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `share_status` text;--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `share_bolt11` text;--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `share_payment_hash` text;--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `share_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sprinkles` ADD `share_error` text;
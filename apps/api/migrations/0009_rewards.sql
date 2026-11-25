ALTER TABLE `invoices` ADD `reward_id` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `reward_title` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `contact` text;--> statement-breakpoint
ALTER TABLE `invoices` ADD `reward_sent_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `rewards` text DEFAULT '[]' NOT NULL;
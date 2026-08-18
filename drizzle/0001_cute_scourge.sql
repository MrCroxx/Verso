CREATE TABLE `translations` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`page` integer NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `translations_document_page_idx` ON `translations` (`document_id`,`page`);
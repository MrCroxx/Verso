CREATE TABLE `navigation_pages` (
	`document_id` text NOT NULL,
	`pdf_page` integer NOT NULL,
	`is_table_of_contents` integer NOT NULL,
	`toc_entries` text NOT NULL,
	`page_label` text,
	`page_value` integer,
	`numbering` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `pdf_page`)
);
--> statement-breakpoint
CREATE INDEX `navigation_pages_document_idx` ON `navigation_pages` (`document_id`,`pdf_page`);--> statement-breakpoint
CREATE TABLE `navigation_settings` (
	`document_id` text PRIMARY KEY NOT NULL,
	`manual_offset` integer,
	`updated_at` integer NOT NULL
);

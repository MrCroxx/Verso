CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`name` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`page_count` integer NOT NULL,
	`content_type` text NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_fingerprint_unique` ON `books` (`fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `books_object_key_unique` ON `books` (`object_key`);
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`updated_at` integer NOT NULL
);

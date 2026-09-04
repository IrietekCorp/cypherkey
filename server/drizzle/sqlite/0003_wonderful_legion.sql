PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vault_items` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`cursor` integer NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_vault_items`("id", "user_id", "cursor", "version", "ciphertext", "nonce", "updated_at", "deleted_at") SELECT "id", "user_id", "cursor", "version", "ciphertext", "nonce", "updated_at", "deleted_at" FROM `vault_items`;--> statement-breakpoint
DROP TABLE `vault_items`;--> statement-breakpoint
ALTER TABLE `__new_vault_items` RENAME TO `vault_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
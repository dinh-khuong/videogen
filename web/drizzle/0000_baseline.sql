CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`value` text NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`last_status` text,
	`last_message` text,
	`last_checked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`options` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_tokens_provider` ON `api_tokens` (`provider`,`active`);--> statement-breakpoint
CREATE TABLE `asset_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`parent_id` text,
	`color` text,
	`starred` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `asset_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_folders_parent` ON `asset_folders` (`parent_id`);--> statement-breakpoint
CREATE TABLE `asset_tags` (
	`asset_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `tag_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`thumbnail` text,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`source_url` text,
	`width` integer,
	`height` integer,
	`size_bytes` integer,
	`sha1` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`kind` text DEFAULT 'image' NOT NULL,
	`duration` real,
	`ocr_text` text DEFAULT '' NOT NULL,
	`ai_summary` text DEFAULT '' NOT NULL,
	`ai_tags` text DEFAULT '[]' NOT NULL,
	`analysis_status` text DEFAULT 'pending' NOT NULL,
	`analysis_error` text,
	`analyzed_at` text,
	`folder_id` text,
	FOREIGN KEY (`folder_id`) REFERENCES `asset_folders`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_sha1_unique` ON `assets` (`sha1`);--> statement-breakpoint
CREATE INDEX `assets_analysis` ON `assets` (`analysis_status`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_folder` ON `assets` (`folder_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contact_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`type` text DEFAULT 'note' NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contact_activities_contact` ON `contact_activities` (`contact_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contact_tags` (
	`contact_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `tag_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contact_videos` (
	`contact_id` text NOT NULL,
	`video_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`contact_id`, `video_id`),
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`company` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'lead' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`follow_up_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`input` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`stage` text,
	`message` text,
	`error` text,
	`video_id` text,
	`contact_id` text,
	`pid` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`duration_seconds` real,
	`estimated_seconds` real,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `video_assets` (
	`video_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`step` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`video_id`, `step`, `position`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_assets_asset` ON `video_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `video_tags` (
	`video_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`video_id`, `tag_id`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY NOT NULL,
	`file` text NOT NULL,
	`thumbnail` text,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'generated' NOT NULL,
	`duration` real,
	`width` integer,
	`height` integer,
	`size_bytes` integer,
	`script` text,
	`job_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);

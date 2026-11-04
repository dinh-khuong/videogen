ALTER TABLE `videos` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `settings` text;--> statement-breakpoint
-- Video đã có: lấy prompt và cài đặt từ job tạo ra nó (job dựng từ kịch bản sửa tay không có prompt riêng)
UPDATE `videos` SET
  `prompt` = (SELECT `jobs`.`topic` FROM `jobs` WHERE `jobs`.`id` = `videos`.`job_id`),
  `settings` = (SELECT json_remove(`jobs`.`input`, '$.topic', '$.script', '$.sourceVideoId', '$.feedback', '$.baseJobId') FROM `jobs` WHERE `jobs`.`id` = `videos`.`job_id`)
WHERE EXISTS (SELECT 1 FROM `jobs` WHERE `jobs`.`id` = `videos`.`job_id` AND json_extract(`jobs`.`input`, '$.script') IS NULL);--> statement-breakpoint
-- Video dựng lại từ kịch bản sửa tay thừa hưởng prompt của video gốc; chạy hai lượt để cả video sửa từ một video đã sửa cũng có
UPDATE `videos` SET `prompt` = `src`.`prompt`, `settings` = `src`.`settings`
FROM `jobs` AS `j`, `videos` AS `src`
WHERE `j`.`id` = `videos`.`job_id` AND `src`.`id` = json_extract(`j`.`input`, '$.sourceVideoId') AND `src`.`prompt` IS NOT NULL AND `videos`.`prompt` IS NULL;--> statement-breakpoint
UPDATE `videos` SET `prompt` = `src`.`prompt`, `settings` = `src`.`settings`
FROM `jobs` AS `j`, `videos` AS `src`
WHERE `j`.`id` = `videos`.`job_id` AND `src`.`id` = json_extract(`j`.`input`, '$.sourceVideoId') AND `src`.`prompt` IS NOT NULL AND `videos`.`prompt` IS NULL;

-- Written by hand: the memory_global_write surface is now memory_shared_write; carry over the modes set on it.
UPDATE `settings`
SET `value` = json_remove(json_set(`value`, '$.memory_shared_write', json_extract(`value`, '$.memory_global_write')), '$.memory_global_write')
WHERE `key` = 'orchestratorModes' AND json_type(`value`, '$.memory_global_write') IS NOT NULL;--> statement-breakpoint
UPDATE `bots`
SET `orchestrator_modes` = json_remove(json_set(`orchestrator_modes`, '$.memory_shared_write', json_extract(`orchestrator_modes`, '$.memory_global_write')), '$.memory_global_write')
WHERE json_type(`orchestrator_modes`, '$.memory_global_write') IS NOT NULL;

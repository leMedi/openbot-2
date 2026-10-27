-- Questions asked before #40 left unanswered: the first run after the update shouldn't list them all at once.
UPDATE `messages` SET `card_state` = json_patch(coalesce(`card_state`, '{}'), '{"reminded":true}')
WHERE json_extract(`card`, '$.type') = 'question' AND json_extract(`card_state`, '$.answer') IS NULL;

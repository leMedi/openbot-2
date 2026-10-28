-- Memory extraction and consolidation write no audit entries any more, as Grok's memory side calls don't; their old
-- entries go, since the API no longer knows their kinds.
DELETE FROM `audit_log` WHERE `kind` IN ('extraction', 'consolidation');

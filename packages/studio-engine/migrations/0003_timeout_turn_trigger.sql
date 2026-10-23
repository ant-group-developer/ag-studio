-- A turn that ran out of time goes on by itself (prod 22-23/10: 7 turns cut at 20 minutes): the turn that continues it
-- and the note before it carry trigger `timeout`.
ALTER TABLE agent_messages DROP CONSTRAINT IF EXISTS agent_messages_trigger_check;
ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_trigger_check
  CHECK (trigger IN ('user', 'job', 'action', 'autofix', 'system', 'timeout'));

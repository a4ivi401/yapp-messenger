-- 012_message_replies.sql
-- Відповіді на повідомлення (reply_to_id).
-- При видаленні цільового повідомлення зв'язок лишається (або стає NULL, якщо запис вилучено фізично).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_reply_to_id_idx
  ON messages(reply_to_id)
  WHERE reply_to_id IS NOT NULL;

-- 009_reactions_edit_delete.sql
-- Реакції на повідомлення (одна реакція користувача на одне повідомлення, toggle),
-- редагування (edited_at) та видалення (tombstone через deleted_at).

-- Реакції: масив-агрегат не годиться, бо два користувачі можуть поставити реакцію
-- одночасно (read-modify-write race). Окремі рядки + агрегація запитом — race-free.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Одна реакція на користувача на повідомлення: клацання по тому сам емодзі
  -- знімає її (toggle), інше — замінює
  PRIMARY KEY (message_id, user_id)
);

-- Агрегат по історії повідомлення діалогу: WHERE message_id (без user_id)
CREATE INDEX IF NOT EXISTS message_reactions_message_id_idx
  ON message_reactions(message_id);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Tombstone (видалене повідомлення) не має ані тіла, ані вкладення,
-- тому content-check з 007 (гарантує непорожність) потрібно послабити:
-- валідні два стани — звичайне повідомлення і tombstone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'messages_content_check' AND conrelid = 'messages'::regclass
  ) THEN
    ALTER TABLE messages DROP CONSTRAINT messages_content_check;
  END IF;
END $$;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_check
  CHECK (
    deleted_at IS NOT NULL
    OR length(trim(COALESCE(body, ''))) > 0
    OR attachment_url IS NOT NULL
  );

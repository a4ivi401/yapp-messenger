-- 007_media_attachments.sql
-- Медіа-файли та вкладення до повідомлень (фото, документи, архіви).
--
-- Повідомлення може містити:
--   - лише текст (body);
--   - лише вкладення (attachment_url);
--   - текст + вкладення (підпис до фото або файлу).
--
-- Тому body перестає бути NOT NULL (за замовчуванням ''), але додається CHECK-констрейнт,
-- який гарантує, що повідомлення не є порожнім.

ALTER TABLE messages
  ALTER COLUMN body DROP NOT NULL,
  ALTER COLUMN body SET DEFAULT '';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment_url text,
  ADD COLUMN IF NOT EXISTS attachment_type varchar(32),
  ADD COLUMN IF NOT EXISTS attachment_name text,
  ADD COLUMN IF NOT EXISTS attachment_size integer,
  ADD COLUMN IF NOT EXISTS attachment_mime text;

-- Обмеження: допустимі типи вкладень (на майбутнє: 'image', 'file', 'audio', 'video')
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_attachment_type_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_attachment_type_check
      CHECK (attachment_type IS NULL OR attachment_type IN ('image', 'file', 'audio', 'video'));
  END IF;
END $$;

-- Обмеження: повідомлення має містити або непустий текст, або вкладення
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_content_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_content_check
      CHECK (length(trim(COALESCE(body, ''))) > 0 OR attachment_url IS NOT NULL);
  END IF;
END $$;

-- Індекс для швидкої вибірки повідомлень із вкладеннями (наприклад, медіа-галерея діалогу)
CREATE INDEX IF NOT EXISTS messages_conversation_attachments_idx
  ON messages(conversation_id, created_at DESC)
  WHERE attachment_url IS NOT NULL;

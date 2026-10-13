-- 003_contacts.sql
-- Таблиця контактів між користувачами.
-- Запис (user_id, contact_user_id) означає, що user_id зберіг contact_user_id у свої контакти.

CREATE TABLE IF NOT EXISTS contacts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, contact_user_id),
  CONSTRAINT contacts_no_self_contact CHECK (user_id <> contact_user_id)
);

CREATE INDEX IF NOT EXISTS contacts_contact_user_id_idx
  ON contacts(contact_user_id);

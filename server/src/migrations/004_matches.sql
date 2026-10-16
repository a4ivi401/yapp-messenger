-- 004_matches.sql
-- Історія взаємних метчів у випадковому чаті.
-- Рядок створюється лише тоді, коли ОБИДВА співрозмовники натиснули «🤝 Додати в контакти»
-- і анонімний чат конвертувався у постійний діалог.
--
-- user1_id/user2_id зберігаються у канонічному порядку (менший UUID першим),
-- тому унікальний індекс не дає записати одну й ту саму пару двічі у різних порядках.

CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user2_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT matches_no_self CHECK (user1_id <> user2_id),
  CONSTRAINT matches_ordered CHECK (user1_id < user2_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS matches_pair_key
  ON matches(user1_id, user2_id);

CREATE INDEX IF NOT EXISTS matches_user2_id_idx
  ON matches(user2_id);

CREATE INDEX IF NOT EXISTS matches_created_at_idx
  ON matches(created_at DESC);

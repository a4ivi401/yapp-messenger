-- Міграція 011: Профілі користувачів (відображуване ім'я, аватарка, біографія)
-- Дозволяє користувачам налаштовувати свій профіль та переглядати профілі співрозмовників.

ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;

-- Індекс для швидкого нечутливого до регістру пошуку за відображуваним ім'ям
CREATE INDEX IF NOT EXISTS users_display_name_lower_idx ON users (LOWER(display_name));

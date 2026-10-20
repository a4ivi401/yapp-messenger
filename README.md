# Yapp — месенджер із випадковими співрозмовниками

**🇺🇦 Українська** · [**🇬🇧 English**](README.en.md)

[![Node.js](https://img.shields.io/badge/Node.js-24.18-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io)
[![React](https://img.shields.io/badge/React-18-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

Месенджер, у якому можна поспілкуватися з випадковою незнайомою людиною, а якщо стався **метч** — додати один одного в контакти й спілкуватися далі.

- **💬 Мої чати** — розмови з контактами.
- **🎲 Випадковий співрозмовник** — анонімний чат із незнайомцем. Обидва натиснули «Додати в контакти» → **метч**: чат стає постійним, ніки розкриваються.

> Лабораторна робота за [Programming-Practice-Projects — Lab 01: Mini Messenger](https://github.com/rmalkevy/Programming-Practice-Projects/blob/main/labs/lab-01-messenger.md).

## Стан проєкту

| Блок | Статус |
|---|---|
| Auth: реєстрація / логін / вихід · `scrypt` + httpOnly cookie | ✅ готово |
| Чат і повідомлення в реальному часі (Socket.IO) | ✅ готово |
| Список чатів і контактів із БД + пошук за ніком | ✅ готово |
| Браузерні та звукові сповіщення (Web Audio & Notifications API) | ✅ готово |
| Випадковий анонімний чат, захист від повторів у сесії та обопільний метч | ✅ готово |
| Статуси «✓ надіслано → ✓✓ доставлено → ✓✓ прочитано» та індикатор «друкує…» (Socket.IO) | ✅ готово |
| Медіа / голосові повідомлення | 🎯 у плані |

## Дорожня карта (2 тижні · ~2 год/день ≈ 28 год)

### 🎯 Milestones

| # | Майлстоун | Дні | Статус |
|---|---|---|---|
| **M0** | Каркас проєкту + авторизація | 1 | ✅ готово |
| **M1** | Живий чат — ядро месенджера | 2–4 | ✅ готово |
| **M2** | Випадковий співрозмовник + метчинг (**twist**) | 5–6 | ✅ готово |
| **M3** | Статуси, медіа та екстри | 7–11 | 🚧 7 ✅ · 8–11 у плані |
| **M4** | Деплой і підготовка до захисту | 12–14 | 🎯 у плані |

### 📅 Розклад по днях

Легенда пріоритету: 🟣 **ядро** (без цього не здаси) · ⚪ **залишок** (беремо, якщо встигаємо).

| День | Що робимо | Пріоритет |
|---|---|---|
| **1** ✅ | Каркас: Docker Compose, авторизація (`scrypt` + httpOnly), міграції, UI-оболонка у стилі Telegram + заготовка випадкового чату | 🟣 |
| **2** ✅ | Модель `conversations` + `messages` (міграція 002), REST API діалогів і повідомлень | 🟣 |
| **3** ✅ | Realtime через Socket.IO: авторизація сокета по сесії, кімнати, подія `message:new`, збереження в БД | 🟣 |
| **4** ✅ | Список чатів і контактів із БД: модель `contacts` (міграція 003), пошук за ніком, веб-звук та системні сповіщення | 🟣 |
| **5** ✅ | Випадковий співрозмовник: черга підбору в пам'яті (FIFO), захист від повторної зустрічі в сесії, анонімні образи, ефемерний чат і обопільний метч у контакти | 🟣 |
| **6** ✅ | Метчинг: модель `matches` (міграція 004), канонічне впорядкування пар UUID, збереження взаємного метчу в БД при обопільній згоді, статистика метчів, realtime `match:new`, бейджі «🎲 Метч» | 🟣 |
| **7** ✅ | Статуси «доставлено / прочитано» + індикатор «друкує…» + реальна присутність («в мережі» / «востаннє …»): watermark-модель `conversation_participants` (міграція 005), `users.last_seen_at` (міграція 006), події `conversation:read`, `message:delivered`, `typing`, `presence:update`; бейдж «🎲 Метч» прибрано зі списку чатів і шапки (повернеться окремим акцентом) | 🟣 мінімум |
| **8** ✅ | Медіа: фото й файли (`multer`, volume `uploads`), прев'ю зображень, модальний lightbox, безпечне збереження та скачування | ⚪ |
| **9** | Голосові повідомлення (MediaRecorder: запис → завантаження → програвання) | ⚪ |
| **10** | Редагування / видалення повідомлень + пошук по чатах і контактах | ⚪ |
| **11** | Блок / скарга в анонімному чаті + базовий rate-limit | ⚪ |
| **12** | Адаптив і вилизування: порожні стани, помилки, локалізація zod-повідомлень українською | 🟣 поліш |
| **13** | Деплой (Railway / Fly), HTTPS, secure-cookie, env-змінні | 🟣 |
| **14** | Буфер + демо у двох вкладках + фінальний README + підготовка до захисту | 🟣 |

### Пріоритети

**🟣 Основне (ядро — мета захисту):**
- Авторизація ✅
- Живий чат (realtime + збереження в БД)
- Список чатів і контактів
- **Випадковий співрозмовник + метчинг → контакт** — головний козир на захисті
- Мінімальні статуси + «друкує…»
- Адаптивний інтерфейс
- Деплой на HTTPS + демо + README

**⚪ На залишок часу** (додаємо в такому порядку, якщо лишається час):
1. Фото / файли
2. Голосові повідомлення
3. Редагування / видалення + пошук
4. Блок / скарга + rate-limit
5. Темна тема

**🚫 Свідомо поза межами** (щоб вкластися в ~28 год):
- E2E-шифрування — замість нього HTTPS + `scrypt`
- Відео-повідомлення (кружечки)
- Пуш-сповіщення
- Групові чати

## Технології

- **Бекенд:** Node.js, Express, Socket.IO, PostgreSQL (`pg`), валідація через zod, паролі через `crypto.scrypt`
- **Фронтенд:** React, Vite, react-router, socket.io-client
- **Інфраструктура:** Docker Compose (PostgreSQL + сервер + клієнт — три контейнери)

## Запуск у Docker (одним стеком)

```bash
docker compose up -d --build    # зібрати та підняти всі контейнери
# або скорочено: npm run docker:up
```

Відкрий **http://localhost:8080** — nginx-клієнт проксірує `/api` і `/socket.io` на сервер.

- Клієнт (React, nginx, статика): http://localhost:8080
- Сервер (API + Socket.IO) напряму: http://localhost:3001
- PostgreSQL — порт `5433`, база/юзер `yapp` / `yapp_dev`

Контейнери можна підняти й **окремо**, якщо потрібно:

```bash
docker build -t yapp-server ./server
docker run -d -p 3001:3001 -e DATABASE_URL=… yapp-server

docker build -t yapp-client ./client
docker run -d -p 8080:80 -e BACKEND_URL=http://<server-host>:3001 yapp-client
```

## Розробка (hot reload, без контейнерів)

Для швидкої роботи з автозаміною (Vite HMR, `node --watch`):

```bash
npm install              # один раз
npm run db:up            # PostgreSQL у Docker (порт 5433)
npm run migrate          # створити таблиці
npm run dev              # сервер :3001 + фронт :5173 одночасно
```

Відкрий **http://localhost:5173**. (Якщо порти зайняті стеком — спершу `docker compose down`.)

## API

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/api/auth/register` | `{ username, password }` — створити акаунт і розпочати сесію |
| POST | `/api/auth/login` | увійти |
| POST | `/api/auth/logout` | вийти |
| GET | `/api/auth/me` | поточний користувач (за cookie) |
| GET | `/api/conversations` | список діалогів поточного користувача (зі співрозмовником, прев'ю останнього повідомлення та watermark-ами прочитання) |
| POST | `/api/conversations` | `{ username }` — почати або відкрити наявний прямий діалог |
| GET | `/api/conversations/:id` | деталі діалогу (лише для учасника) |
| GET | `/api/conversations/:id/messages` | історія повідомлень (містить `senderUsername`); пагінація `?limit=50&before=<id>` |
| POST | `/api/conversations/:id/messages` | `{ body?, attachment? }` — надіслати повідомлення (текст, вкладення або обидва) |
| GET | `/api/contacts` | список збережених контактів користувача та загальна кількість `{ contacts, count }` |
| POST | `/api/contacts` | `{ username }` або `{ userId }` — додати користувача в контакти (ідемпотентно, валідація само-додавання) |
| DELETE | `/api/contacts/:userId` | видалити користувача з контактів за UUID |
| GET | `/api/matches` | історія взаємних метчів користувача `{ matches }` |
| GET | `/api/matches/stats` | зведена статистика користувача `{ matchesCount, contactsCount }` |
| GET | `/api/users/search?q=...` | глобальний пошук користувачів за підрядком нікнейму з прапорцем `isContact` |
| POST | `/api/uploads` | `multipart/form-data` з полем `file` — завантаження фото або файлу (до 20 МБ); повертає `{ attachment: { url, type, name, size, mime } }` |
| GET | `/api/uploads/files/:filename` | пряма роздача медіафайлу з `Cache-Control: immutable` та `X-Content-Type-Options: nosniff` |
| GET | `/api/uploads/download/:filename?name=...` | безпечне скачування файлу з оригінальною назвою (`Content-Disposition: attachment`) |

### Статуси повідомлень

Квитанції зберігаються не на кожному повідомленні, а як **watermark на учасника діалогу**
(`conversation_participants.last_delivered_at` / `last_read_at`):

- `last_delivered_at` — час найновішого повідомлення, яке клієнт учасника отримав;
- `last_read_at` — час найновішого повідомлення, яке учасник бачив у відкритому чаті.

Статус власного повідомлення виводиться порівнянням `message.createdAt` з watermark-ами
співрозмовника: `✓` надіслано → `✓✓` доставлено → `✓✓` прочитано. На N повідомлень
припадає O(1) записів, а «прочитано» завжди означає «доставлено» (read піднімає й delivered) —
стан «прочитано, але не доставлено» неможливий у даних. Модель розрахована на direct (1:1);
для групових чатів знадобиться per-recipient таблиця квитанцій.

Об'єкт діалогу в API віддає ці watermark-и як `otherUser.lastDeliveredAt` та `otherUser.lastReadAt`,
тож клієнт малює тіки одразу після завантаження історії, без окремого запиту.


### Socket.IO (Realtime)

Підключення: `ws://<host>/socket.io` (або `http://<host>/socket.io` для polling).  
Авторизація: автоматично через httpOnly cookie `sid` (handshake). Неавторизоване підключення відхиляється (`Error: Не авторизовано`).

При підключенні кожен користувач автоматично приєднується до власної приватної кімнати `user:<userId>`, що дозволяє отримувати події про нові повідомлення навіть для неактивних у даний момент діалогів.

#### Клієнтські події (Client → Server)

| Подія | Корисне навантаження | Ack-відповідь | Опис |
|---|---|---|---|
| `conversation:join` | `{ conversationId }` | `{ ok: true }` або `{ ok: false, error }` | Приєднання до кімнати діалогу `conversation:<id>` (доступно лише учасникам) |
| `conversation:leave` | `{ conversationId }` | `{ ok: true }` | Вихід із кімнати діалогу |
| `message:send` | `{ conversationId, body?, attachment? }` | `{ ok: true, message }` або `{ ok: false, error }` | Збереження повідомлення в БД та трансляція в кімнату діалогу та особисті кімнати учасників (підтримує текст, медіавкладення або обидва) |
| `conversation:read` | `{ conversationId }` | `{ ok: true }` | Позначає всі вхідні діалогу прочитаними (піднімає watermark) і повідомляє співрозмовника подією `message:read`. Повторний виклик без нових вхідних — no-op без broadcast |
| `message:delivered` | `{ messageId }` | `{ ok: true }` | Підтвердження доставки повідомлення одержувачем; відправник отримує `message:delivered` |
| `typing` | `{ conversationId, isTyping }` | `{ ok: true }` або `{ ok: false, error }` | Індикатор «друкує…» у прямому діалозі. Сервер лише релеїть подію (без стану), старт тротлиться 500 мс на адресата |
| `stranger:typing` | `{ sessionId, isTyping }` | `{ ok: true }` або `{ ok: false, error }` | Те саме для анонімного чату |
| `stranger:search` | — | `{ ok: true, status }` | Початок пошуку випадкового співрозмовника або постановка в FIFO чергу |
| `stranger:cancel` | — | `{ ok: true }` | Скасування пошуку та видалення з черги |
| `stranger:message` | `{ sessionId, body?, attachment? }` | `{ ok: true, message }` | Відправка ефемерного повідомлення незнайомцю (текст до 4000 символів, медіавкладення або обидва) |
| `stranger:next` | — | `{ ok: true, status }` | Пропуск співрозмовника («🎲 Інший»): фіксація виключення пари з повторного підбору в сесії та негайний новий пошук |
| `stranger:leave` | — | `{ ok: true }` | Завершення розмови зі співрозмовником з виключенням повторного підбору |
| `stranger:match-request` | `{ sessionId }` | `{ ok: true, mutual }` | Запит «🤝 Додати в контакти». При обопільній згоді зберігає повідомлення в БД і відкриває особистості |

#### Серверні події (Server → Client)

| Подія | Корисне навантаження | Опис |
|---|---|---|
| `message:new` | `{ message }` | Нове повідомлення з розширеними полями (зокрема `senderUsername`). Транслюється в кімнату діалогу `conversation:<id>` та в персональні кімнати співрозмовників `user:<userId>` для оновлення сайдбару, відтворення аудіо та показу системного сповіщення |
| `stranger:matched` | `{ sessionId, myAnon, partner }` | Співрозмовника знайдено! Передаються анонімні образи без реальних нікнеймів |
| `stranger:message` | `{ message }` | Ефемерне повідомлення в кімнаті `stranger:<sessionId>` |
| `stranger:match-invited` | `{ sessionId }` | Партнер надіслав запит на додавання в контакти |
| `stranger:revealed` | `{ sessionId, conversationId, conversation, partner }` | Взаємний метч! Нікнейми відкрито, діалог переведено в постійний у контактах |
| `stranger:left` | `{ sessionId, reason }` | Співрозмовник залишив чат або перейшов до іншого (`reason: 'next' \| 'left' \| 'disconnected'`) |
| `contact:new` | `{ contact }` | Поява нового контакту в списку після обопільного знайомства |
| `match:new` | `{ match }` | Новий взаємний метч у реальному часі для миттєвого оновлення лічильників |
| `message:read` | `{ conversationId, userId, lastReadAt }` | Співрозмовник прочитав діалог — тіки власних повідомлень стають «прочитано» |
| `message:delivered` | `{ conversationId, messageId, userId, lastDeliveredAt }` | Співрозмовник отримав повідомлення на свій пристрій (тіки стають `✓✓`) |
| `typing` | `{ conversationId, userId, isTyping }` | Співрозмовник друкує в прямому діалозі. Клієнт-одержувач гасить індикатор сам за 4 с без нових сигналів |
| `stranger:typing` | `{ sessionId, userId, isTyping }` | Співрозмовник друкує в анонімному чаті |
| `presence:update` | `{ userId, isOnline, lastSeenAt }` | Зміна присутності користувача (підключився / вийшов). Розсилається лише співрозмовникам по діалогах та контактам (приватність) |

## Структура

```txt
yapp-messenger/
  docker-compose.yml      # три сервіси: postgres + server + client
  server/
    Dockerfile            # Node.js: API + Socket.IO (+ міграції при старті)
    src/migrations/       # SQL-міграції
  client/
    Dockerfile            # build React → nginx з проксі до сервера
    nginx.template.conf   # статика + проксі /api, /socket.io
```

## Безпека

- Паролі — `crypto.scrypt` із випадковою сіллю (`salt:hash`), звірення через `timingSafeEqual`.
- Сесії — випадковий токен у БД, передається лише в httpOnly cookie.
- Усюди параметризовані SQL-запити; валідація вводу через zod.
- Завантаження файлів — обмеження розміру 20 МБ, блокування небезпечних/виконуваних розширень (.exe, .bat, .sh, .php тощо), валідація UUID-імен сховища проти path traversal, ізольований volume `uploads`.
- У плані: HTTPS на деплої.

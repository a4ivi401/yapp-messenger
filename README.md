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
| Випадкові співрозмовники та метчинг | 🎯 у плані |
| Медіа / голосові повідомлення / статуси | 🎯 у плані |

## Дорожня карта (2 тижні · ~2 год/день ≈ 28 год)

### 🎯 Milestones

| # | Майлстоун | Дні | Статус |
|---|---|---|---|
| **M0** | Каркас проєкту + авторизація | 1 | ✅ готово |
| **M1** | Живий чат — ядро месенджера | 2–4 | ✅ готово |
| **M2** | Випадковий співрозмовник + метчинг (**twist**) | 5–6 | 🎯 далі |
| **M3** | Статуси, медіа та екстри | 7–11 | 🎯 у плані |
| **M4** | Деплой і підготовка до захисту | 12–14 | 🎯 у плані |

### 📅 Розклад по днях

Легенда пріоритету: 🟣 **ядро** (без цього не здаси) · ⚪ **залишок** (беремо, якщо встигаємо).

| День | Що робимо | Пріоритет |
|---|---|---|
| **1** ✅ | Каркас: Docker Compose, авторизація (`scrypt` + httpOnly), міграції, UI-оболонка у стилі Telegram + заготовка випадкового чату | 🟣 |
| **2** ✅ | Модель `conversations` + `messages` (міграція 002), REST API діалогів і повідомлень | 🟣 |
| **3** ✅ | Realtime через Socket.IO: авторизація сокета по сесії, кімнати, подія `message:new`, збереження в БД | 🟣 |
| **4** ✅ | Список чатів і контактів із БД: модель `contacts` (міграція 003), пошук за ніком, веб-звук та системні сповіщення | 🟣 |
| **5** | Випадковий співрозмовник: черга підбору в пам'яті (`stranger:search` → `stranger:matched`), ефемерний чат, анонімний нік + емодзі-аватар | 🟣 |
| **6** | Метчинг: таблиця `matches`, обопільний `match:request` → апгрейд чату в контакт і розкриття ніків; «новий співрозмовник» закриває ефемерний чат | 🟣 |
| **7** | Статуси «доставлено / прочитано» + індикатор «друкує…» через сокет | 🟣 мінімум |
| **8** | Медіа: фото й файли (`multer`, volume `uploads`), прев'ю зображень | ⚪ |
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
| GET | `/api/conversations` | список діалогів поточного користувача (зі співрозмовником і прев'ю останнього повідомлення) |
| POST | `/api/conversations` | `{ username }` — почати або відкрити наявний прямий діалог |
| GET | `/api/conversations/:id` | деталі діалогу (лише для учасника) |
| GET | `/api/conversations/:id/messages` | історія повідомлень (містить `senderUsername`); пагінація `?limit=50&before=<id>` |
| POST | `/api/conversations/:id/messages` | `{ body }` — надіслати повідомлення |
| GET | `/api/contacts` | список збережених контактів користувача та загальна кількість `{ contacts, count }` |
| POST | `/api/contacts` | `{ username }` або `{ userId }` — додати користувача в контакти (ідемпотентно, валідація само-додавання) |
| DELETE | `/api/contacts/:userId` | видалити користувача з контактів за UUID |
| GET | `/api/users/search?q=...` | глобальний пошук користувачів за підрядком нікнейму з прапорцем `isContact` |

### Socket.IO (Realtime)

Підключення: `ws://<host>/socket.io` (або `http://<host>/socket.io` для polling).  
Авторизація: автоматично через httpOnly cookie `sid` (handshake). Неавторизоване підключення відхиляється (`Error: Не авторизовано`).

При підключенні кожен користувач автоматично приєднується до власної приватної кімнати `user:<userId>`, що дозволяє отримувати події про нові повідомлення навіть для неактивних у даний момент діалогів.

#### Клієнтські події (Client → Server)

| Подія | Корисне навантаження | Ack-відповідь | Опис |
|---|---|---|---|
| `conversation:join` | `{ conversationId }` | `{ ok: true }` або `{ ok: false, error }` | Приєднання до кімнати діалогу `conversation:<id>` (доступно лише учасникам) |
| `conversation:leave` | `{ conversationId }` | `{ ok: true }` | Вихід із кімнати діалогу |
| `message:send` | `{ conversationId, body }` | `{ ok: true, message }` або `{ ok: false, error }` | Збереження повідомлення в БД та трансляція в кімнату діалогу та особисті кімнати учасників |

#### Серверні події (Server → Client)

| Подія | Корисне навантаження | Опис |
|---|---|---|
| `message:new` | `{ message }` | Нове повідомлення з розширеними полями (зокрема `senderUsername`). Транслюється в кімнату діалогу `conversation:<id>` та в персональні кімнати співрозмовників `user:<userId>` для оновлення сайдбару, відтворення аудіо та показу системного сповіщення |

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
- У плані: HTTPS на деплої.

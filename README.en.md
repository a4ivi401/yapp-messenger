# Yapp — messenger with random strangers

[**🇺🇦 Українська**](README.md) · **🇬🇧 English**

[![Node.js](https://img.shields.io/badge/Node.js-24.18-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express-4-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![Socket.IO](https://img.shields.io/badge/Socket.IO-4-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://socket.io)
[![React](https://img.shields.io/badge/React-18-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

A messenger where you can chat with a random stranger, and if a **match** happens — add each other to contacts and keep talking.

- **💬 My chats** — conversations with contacts.
- **🎲 Random stranger** — an anonymous chat. Both press **"Add to contacts"** → **match**: the chat becomes permanent, usernames are revealed.

> University lab based on [Programming-Practice-Projects — Lab 01: Mini Messenger](https://github.com/rmalkevy/Programming-Practice-Projects/blob/main/labs/lab-01-messenger.md).

## Project status

| Feature | Status |
|---|---|
| Auth: register / login / logout · `scrypt` + httpOnly cookie | ✅ done |
| Real-time chat & messages (Socket.IO) | ✅ done |
| Chats and contacts from DB + username search | ✅ done |
| Browser & audio chime notifications (Web Audio & Notifications API) | ✅ done |
| Random anonymous chat, session exclusion & mutual match | ✅ done |
| Message statuses «✓ sent → ✓✓ delivered → ✓✓ read» and "typing…" indicator (Socket.IO) | ✅ done |
| Media / voice messages | 🎯 planned |

## Roadmap (2 weeks · ~2 h/day ≈ 28 h)

### 🎯 Milestones

| # | Milestone | Days | Status |
|---|---|---|---|
| **M0** | Project skeleton + auth | 1 | ✅ done |
| **M1** | Live chat — the messenger core | 2–4 | ✅ done |
| **M2** | Random stranger + matching (**twist**) | 5–6 | ✅ done |
| **M3** | Statuses, media & extras | 7–11 | 🚧 7 ✅ · 8–11 planned |
| **M4** | Deployment & defense prep | 12–14 | 🎯 planned |

### 📅 Day-by-day

Priority legend: 🟣 **core** (can't pass without it) · ⚪ **leftover** (only if there's time).

| Day | What we build | Priority |
|---|---|---|
| **1** ✅ | Skeleton: Docker Compose, auth (`scrypt` + httpOnly), migrations, Telegram-style UI shell + random-chat stub | 🟣 |
| **2** ✅ | `conversations` + `messages` model (migration 002), REST API for chats and messages | 🟣 |
| **3** ✅ | Realtime via Socket.IO: socket auth by session, rooms, `message:new` event, persistence to DB | 🟣 |
| **4** ✅ | Chats and contacts from the DB: `contacts` model (migration 003), username search, audio chime & system notifications | 🟣 |
| **5** ✅ | Random stranger: in-memory matchmaking queue (FIFO), session exclusion prevention, anonymous personas, ephemeral chat & mutual match to contacts | 🟣 |
| **6** ✅ | Matching: `matches` model (migration 004), canonical UUID pair ordering, mutual match persistence in DB, stats API, realtime `match:new`, visual "🎲 Метч" badges | 🟣 |
| **7** ✅ | "Delivered / read" statuses + "typing…" indicator + real presence ("online" / "last seen …"): watermark model on `conversation_participants` (migration 005), `users.last_seen_at` (migration 006), `conversation:read`, `message:delivered`, `typing`, `presence:update` events; the "🎲 Match" badge was removed from the chat list and header (it will return as a separate accent) | 🟣 minimum |
| **8** ✅ | Media: photos & files (`multer`, `uploads` volume), image previews, modal lightbox, secure storage & downloads | ⚪ |
| **9** | Voice messages (MediaRecorder: record → upload → playback) | ⚪ |
| **10** | Edit / delete messages + search across chats and contacts | ⚪ |
| **11** | Block / report in the anonymous chat + basic rate limiting | ⚪ |
| **12** | Responsive polish: empty states, errors, Ukrainian zod messages | 🟣 polish |
| **13** | Deployment (Railway / Fly), HTTPS, secure cookies, env vars | 🟣 |
| **14** | Buffer + two-tab demo + final README + defense prep | 🟣 |

### Priorities

**🟣 Core (the goal for the defense):**
- Auth ✅
- Live chat (realtime + DB persistence)
- Chats and contacts list
- **Random stranger + matching → contact** — the main highlight at the defense
- Minimal statuses + "typing…"
- Responsive interface
- HTTPS deployment + demo + README

**⚪ Leftover time** (add in this order, if time remains):
1. Photos / files
2. Voice messages
3. Edit / delete + search
4. Block / report + rate limiting
5. Dark theme

**🚫 Deliberately out of scope** (to fit ~28 h):
- E2E encryption — HTTPS + `scrypt` instead
- Video messages (round clips)
- Push notifications
- Group chats

## Tech stack

- **Backend:** Node.js, Express, Socket.IO, PostgreSQL (`pg`), validation with zod, passwords via `crypto.scrypt`
- **Frontend:** React, Vite, react-router, socket.io-client
- **Infrastructure:** Docker Compose (PostgreSQL + server + client — three containers)

## Docker (one stack)

```bash
docker compose up -d --build    # build & start all containers
# or: npm run docker:up
```

Open **http://localhost:8080** — nginx proxies `/api` and `/socket.io` to the server container.

- Client (React, nginx, static files): http://localhost:8080
- Server (API + Socket.IO) directly: http://localhost:3001
- PostgreSQL: port `5433`, DB/user `yapp` / `yapp_dev`

To run a single container on its own:

```bash
docker build -t yapp-server ./server
docker run -d -p 3001:3001 -e DATABASE_URL=… yapp-server

docker build -t yapp-client ./client
docker run -d -p 8080:80 -e BACKEND_URL=http://<server-host>:3001 yapp-client
```

## Development (hot reload, host processes)

For Vite HMR and `node --watch`:

```bash
npm install              # once
npm run db:up            # PostgreSQL in Docker (port 5433)
npm run migrate          # create tables
npm run dev              # server :3001 + frontend :5173
```

Open **http://localhost:5173**. (Kill the docker stack first if ports are taken: `docker compose down`.)

## API

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | `{ username, password }` — create account & start a session |
| POST | `/api/auth/login` | sign in |
| POST | `/api/auth/logout` | sign out |
| GET | `/api/auth/me` | current user (via cookie) |
| GET | `/api/conversations` | user's conversations (with participant, last message preview and read watermarks) |
| POST | `/api/conversations` | `{ username }` — find or create direct conversation |
| GET | `/api/conversations/:id` | conversation details (participant only) |
| GET | `/api/conversations/:id/messages` | message history (includes `senderUsername`); pagination `?limit=50&before=<id>` |
| POST | `/api/conversations/:id/messages` | `{ body?, attachment? }` — send a message (text, attachment, or both) |
| GET | `/api/contacts` | list of saved contacts and total count `{ contacts, count }` |
| POST | `/api/contacts` | `{ username }` or `{ userId }` — add user to contacts (idempotent, self-contact validation) |
| DELETE | `/api/contacts/:userId` | remove user from contacts by UUID |
| GET | `/api/matches` | user's mutual match history `{ matches }` |
| GET | `/api/matches/stats` | aggregated user stats `{ matchesCount, contactsCount }` |
| GET | `/api/users/search?q=...` | global user search by username substring with `isContact` flag |
| POST | `/api/uploads` | `multipart/form-data` with `file` field — upload photo or file (up to 20 MB); returns `{ attachment: { url, type, name, size, mime } }` |
| GET | `/api/uploads/files/:filename` | direct media file delivery with `Cache-Control: immutable` and `X-Content-Type-Options: nosniff` |
| GET | `/api/uploads/download/:filename?name=...` | secure file download preserving original filename (`Content-Disposition: attachment`) |

### Message statuses

Receipts are not stored per message; they are stored as a **watermark on a conversation participant**
(`conversation_participants.last_delivered_at` / `last_read_at`):

- `last_delivered_at` — timestamp of the newest message the participant's client received;
- `last_read_at` — timestamp of the newest message the participant has seen in the open chat.

The sender derives each message status by comparing `message.createdAt` with the partner's watermarks:
`✓` sent → `✓✓` delivered → `✓✓` read. N messages cost O(1) writes, and "read" always implies
"delivered" (the read watermark lifts the delivered one too), so the impossible state
"read but not delivered" cannot exist in the data. The model targets direct (1:1) chats;
group chats would need a per-recipient receipts table.

The conversation object exposes these watermarks as `otherUser.lastDeliveredAt` and
`otherUser.lastReadAt`, so the client renders ticks right after loading history, with no extra request.

### Socket.IO (Realtime)

Connection: `ws://<host>/socket.io` (or `http://<host>/socket.io` for polling).  
Authentication: automatic via httpOnly `sid` cookie (handshake). Unauthenticated connections are rejected (`Error: Не авторизовано`).

Upon connection, each authenticated user automatically joins their own private room `user:<userId>`, allowing background event delivery and notifications even for inactive chats.

#### Client Events (Client → Server)

| Event | Payload | Ack Response | Description |
|---|---|---|---|
| `conversation:join` | `{ conversationId }` | `{ ok: true }` or `{ ok: false, error }` | Join room `conversation:<id>` (participants only) |
| `conversation:leave` | `{ conversationId }` | `{ ok: true }` | Leave conversation room |
| `message:send` | `{ conversationId, body?, attachment? }` | `{ ok: true, message }` or `{ ok: false, error }` | Persist message to DB and broadcast to conversation room & participant private rooms (supports text, media attachment, or both) |
| `conversation:read` | `{ conversationId }` | `{ ok: true }` | Mark all incoming messages of the conversation as read (lifts the watermark) and notify the partner via `message:read`. Repeating with no new incoming messages is a no-op with no broadcast |
| `message:delivered` | `{ messageId }` | `{ ok: true }` | Delivery acknowledgement from the recipient; the sender receives `message:delivered` |
| `typing` | `{ conversationId, isTyping }` | `{ ok: true }` or `{ ok: false, error }` | "Typing…" indicator in a direct chat. The server only relays the event (stateless); starts are throttled to 500 ms per recipient |
| `stranger:typing` | `{ sessionId, isTyping }` | `{ ok: true }` or `{ ok: false, error }` | Same for the anonymous chat |
| `stranger:search` | — | `{ ok: true, status }` | Start searching for a random stranger or enter the FIFO queue |
| `stranger:cancel` | — | `{ ok: true }` | Cancel search and remove from queue |
| `stranger:message` | `{ sessionId, body?, attachment? }` | `{ ok: true, message }` | Send an ephemeral message to the stranger (text up to 4000 characters, media attachment, or both) |
| `stranger:next` | — | `{ ok: true, status }` | Skip current stranger («🎲 Next»): record session exclusion to prevent re-matching and search for a new partner |
| `stranger:leave` | — | `{ ok: true }` | Leave stranger chat and mark mutual exclusion in session |
| `stranger:match-request` | `{ sessionId }` | `{ ok: true, mutual }` | Send contact request («🤝 Add to contacts»). When mutual, saves messages to DB and reveals identities |

#### Server Events (Server → Client)

| Event | Payload | Description |
|---|---|---|
| `message:new` | `{ message }` | New message with enriched attributes (including `senderUsername`). Emitted to `conversation:<id>` and recipients' private rooms `user:<userId>` for sidebar refresh, audio chimes, and browser notifications |
| `stranger:matched` | `{ sessionId, myAnon, partner }` | Stranger matched! Emits anonymous personas without real usernames |
| `stranger:message` | `{ message }` | Ephemeral message delivered in room `stranger:<sessionId>` |
| `stranger:match-invited` | `{ sessionId }` | Partner sent an invitation to exchange contacts |
| `stranger:revealed` | `{ sessionId, conversationId, conversation, partner }` | Mutual match! Real usernames revealed, chat converted to permanent contact |
| `stranger:left` | `{ sessionId, reason }` | Partner left or skipped to another stranger (`reason: 'next' \| 'left' \| 'disconnected'`) |
| `message:read` | `{ conversationId, userId, lastReadAt }` | Partner read the conversation — ticks of own messages turn "read" |
| `message:delivered` | `{ conversationId, messageId, userId, lastDeliveredAt }` | Partner's device received the message (ticks turn `✓✓`) |
| `typing` | `{ conversationId, userId, isTyping }` | Partner is typing in a direct chat. The receiving client hides the indicator on its own after 4 s without new signals |
| `stranger:typing` | `{ sessionId, userId, isTyping }` | Partner is typing in the anonymous chat |
| `contact:new` | `{ contact }` | New contact added to user's list after mutual match |
| `match:new` | `{ match }` | Realtime notification of newly recorded match to sync counters immediately |
| `presence:update` | `{ userId, isOnline, lastSeenAt }` | User presence state change (connected / disconnected). Broadcast only to direct chat partners and contacts (privacy boundary) |

## Structure

```txt
yapp-messenger/
  docker-compose.yml      # three services: postgres + server + client
  server/
    Dockerfile            # Node.js: API + Socket.IO (+ migrations at startup)
    src/migrations/       # SQL migrations
  client/
    Dockerfile            # build React → nginx proxying to the server
    nginx.template.conf   # static files + /api, /socket.io proxy
```

## Security

- Passwords — `crypto.scrypt` with a random salt (`salt:hash`), verified with `timingSafeEqual`.
- Sessions — random token stored in DB, carried only in an httpOnly cookie.
- Parameterized SQL everywhere; input validated with zod.
- File uploads — 20 MB size limit, dangerous/executable extension blocking (.exe, .bat, .sh, .php, etc.), UUID storage filename validation preventing path traversal, isolated `uploads` volume.
- Planned: HTTPS on deployment.
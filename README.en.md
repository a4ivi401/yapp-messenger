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
| Random strangers & matching | 🎯 planned |
| Media / voice messages / message statuses | 🎯 planned |

## Roadmap (2 weeks · ~2 h/day ≈ 28 h)

### 🎯 Milestones

| # | Milestone | Days | Status |
|---|---|---|---|
| **M0** | Project skeleton + auth | 1 | ✅ done |
| **M1** | Live chat — the messenger core | 2–4 | 🚧 in progress |
| **M2** | Random stranger + matching (**twist**) | 5–6 | 🎯 next |
| **M3** | Statuses, media & extras | 7–11 | 🎯 planned |
| **M4** | Deployment & defense prep | 12–14 | 🎯 planned |

### 📅 Day-by-day

Priority legend: 🟣 **core** (can't pass without it) · ⚪ **leftover** (only if there's time).

| Day | What we build | Priority |
|---|---|---|
| **1** ✅ | Skeleton: Docker Compose, auth (`scrypt` + httpOnly), migrations, Telegram-style UI shell + random-chat stub | 🟣 |
| **2** ✅ | `conversations` + `messages` model (migration 002), REST API for chats and messages | 🟣 |
| **3** ✅ | Realtime via Socket.IO: socket auth by session, rooms, `message:new` event, persistence to DB | 🟣 |
| **4** | Chats and contacts from the DB: `contacts` model, a real list instead of the stub (preview, time, sorting) | 🟣 |
| **5** | Random stranger: in-memory matchmaking queue (`stranger:search` → `stranger:matched`), ephemeral chat, anonymous handle + emoji avatar | 🟣 |
| **6** | Matching: `matches` table, mutual `match:request` → upgrade the chat to a contact and reveal usernames; "next stranger" closes the ephemeral chat | 🟣 |
| **7** | "Delivered / read" statuses + "typing…" indicator over the socket | 🟣 minimum |
| **8** | Media: photos & files (`multer`, `uploads` volume), image previews | ⚪ |
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
| GET | `/api/conversations` | user's conversations (with participant and last message preview) |
| POST | `/api/conversations` | `{ username }` — find or create direct conversation |
| GET | `/api/conversations/:id` | conversation details (participant only) |
| GET | `/api/conversations/:id/messages` | message history; pagination `?limit=50&before=<id>` |
| POST | `/api/conversations/:id/messages` | `{ body }` — send a message |

### Socket.IO (Realtime)

Connection: `ws://<host>/socket.io` (or `http://<host>/socket.io` for polling).  
Authentication: automatic via httpOnly `sid` cookie (handshake). Unauthenticated connections are rejected (`Error: Не авторизовано`).

#### Client Events (Client → Server)

| Event | Payload | Ack Response | Description |
|---|---|---|---|
| `conversation:join` | `{ conversationId }` | `{ ok: true }` or `{ ok: false, error }` | Join room `conversation:<id>` (participants only) |
| `conversation:leave` | `{ conversationId }` | `{ ok: true }` | Leave conversation room |
| `message:send` | `{ conversationId, body }` | `{ ok: true, message }` or `{ ok: false, error }` | Persist message to DB and broadcast to room |

#### Server Events (Server → Client)

| Event | Payload | Description |
|---|---|---|
| `message:new` | `{ message }` | New message in the conversation room (emitted to all room participants) |

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
- Planned: HTTPS on deployment.
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { contactsRouter } from './routes/contacts.js';
import { matchesRouter } from './routes/matches.js';
import { usersRouter } from './routes/users.js';
import { attachUser } from './middleware/auth.js';
import { pool } from './db.js';
import { setupSocket } from './socket.js';
import { flushLastSeen, LAST_SEEN_FLUSH_MS } from './presence.js';

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(attachUser);
app.use('/api/auth', authRouter);
app.use('/api/conversations', conversationsRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/matches', matchesRouter);
app.use('/api/users', usersRouter);

// У проді цей же сервер віддає зібраний фронтенд (client/dist)
const clientDist = path.resolve(import.meta.dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = createServer(app);
export const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.set('io', io);
setupSocket(io);

const port = Number(process.env.PORT || 3001);
server.listen(port, () => {
  console.log(`yapp server → http://localhost:${port}`);
});

// Страховка для «востаннє в мережі»: якщо подія disconnect не надійшла
// (обрив мережі, вбитий процес), мітка в БД інакше залишилася б дуже старою.
// Один UPDATE на хвилину для всіх онлайн-користувачів — незалежно від їх кількості.
const lastSeenTimer = setInterval(() => {
  flushLastSeen().catch((err) => console.error('last_seen flush error:', err));
}, LAST_SEEN_FLUSH_MS);
// unref: таймер не тримає процес живим (важливо для тестів і коректного виходу)
lastSeenTimer.unref();

// Коректне завершення: фіксуємо останню активність перед зупинкою контейнера.
// io.close() закриває і HTTP-сервер, тому окремий server.close() не потрібен.
async function shutdown(signal) {
  console.log(`${signal}: завершуємо роботу`);
  clearInterval(lastSeenTimer);
  try {
    await flushLastSeen();
  } catch (err) {
    console.error('last_seen flush on shutdown failed:', err.message);
  }
  io.close(() => process.exit(0));
  // Запобіжник: якщо якийсь сокет не закрився — не висимо до SIGKILL від Docker
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
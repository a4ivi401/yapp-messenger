import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { Server } from 'socket.io';
import { authRouter } from './routes/auth.js';
import { conversationsRouter } from './routes/conversations.js';
import { contactsRouter } from './routes/contacts.js';
import { usersRouter } from './routes/users.js';
import { attachUser } from './middleware/auth.js';
import { pool } from './db.js';
import { setupSocket } from './socket.js';

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
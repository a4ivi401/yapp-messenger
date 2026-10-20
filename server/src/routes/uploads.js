import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';

// Каталог сховища: /app/uploads у Docker (volume) або uploads/ локально
export const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (fs.existsSync('/app/uploads')
    ? '/app/uploads'
    : path.resolve(import.meta.dirname, '../../uploads'));

// Гарантуємо наявність каталогу
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Заборонені небезпечні розширення (виконувані файли та скрипти)
export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.php',
  '.phtml',
  '.pl',
  '.cgi',
  '.jar',
  '.msi',
  '.scr',
  '.vbs',
  '.com',
  '.ps1',
]);

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export function sanitizeExtension(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  // Дозволяємо лише безпечні символи в розширенні
  return /^\.[a-z0-9]+$/i.test(ext) ? ext : '';
}

export function detectCategory(mimeType, ext) {
  if (mimeType && mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType && mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType && mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (['.mp4', '.webm', '.ogv', '.mov', '.mkv'].includes(ext)) {
    return 'video';
  }
  if (['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.weba'].includes(ext)) {
    return 'audio';
  }
  return 'file';
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = sanitizeExtension(file.originalname);
    const uniqueId = crypto.randomUUID();
    cb(null, `${uniqueId}${ext}`);
  },
});

const fileFilter = (_req, file, cb) => {
  const ext = sanitizeExtension(file.originalname);
  if (BLOCKED_EXTENSIONS.has(ext)) {
    const err = new Error('Завантаження виконуваних файлів та скриптів заборонено');
    err.code = 'BLOCKED_EXTENSION';
    return cb(err, false);
  }
  cb(null, true);
};

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter,
});

export const uploadsRouter = Router();

// Безпечний валідатор імені збереженого файлу (захист від path traversal)
export function isValidStoredFilename(filename) {
  return typeof filename === 'string' && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(filename);
}

// POST /api/uploads — завантаження фото або файлу
uploadsRouter.post(
  '/',
  requireAuth,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Розмір файлу перевищує 100 МБ' });
          }
          return res.status(400).json({ error: `Помилка завантаження: ${err.message}` });
        }
        if (err.code === 'BLOCKED_EXTENSION') {
          return res.status(400).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message || 'Помилка збереження файлу' });
      }
      next();
    });
  },
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не передано' });
    }

    const ext = sanitizeExtension(req.file.originalname);
    const category = detectCategory(req.file.mimetype, ext);
    const storedFilename = req.file.filename;

    const attachment = {
      url: `/api/uploads/files/${storedFilename}`,
      type: category,
      name: req.file.originalname || storedFilename,
      size: req.file.size,
      mime: req.file.mimetype || 'application/octet-stream',
    };

    res.status(201).json({ attachment });
  },
);

// GET /api/uploads/files/:filename — віддача файлу або зображення
uploadsRouter.get('/files/:filename', (req, res) => {
  const { filename } = req.params;
  if (!isValidStoredFilename(filename)) {
    return res.status(400).json({ error: 'Некоректне імʼя файлу' });
  }

  const resolvedPath = path.resolve(UPLOADS_DIR, filename);
  // Захист: файл має знаходитись виключно всередині UPLOADS_DIR
  if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(403).json({ error: 'Доступ заборонено' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'Файл не знайдено' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Кешуємо медіафайл довготривало: UUID файлу унікальний і незмінний
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.sendFile(resolvedPath);
});

// GET /api/uploads/download/:filename — скачування файлу з оригінальною назвою
uploadsRouter.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  if (!isValidStoredFilename(filename)) {
    return res.status(400).json({ error: 'Некоректне імʼя файлу' });
  }

  const resolvedPath = path.resolve(UPLOADS_DIR, filename);
  if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR))) {
    return res.status(403).json({ error: 'Доступ заборонено' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'Файл не знайдено' });
  }

  // Очищаємо оригінальну назву для Content-Disposition
  const rawDownloadName = typeof req.query.name === 'string' ? req.query.name : filename;
  const safeDownloadName = rawDownloadName.replace(/[\r\n\0]/g, '').trim() || filename;

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(resolvedPath, safeDownloadName);
});

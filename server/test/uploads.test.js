import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import {
  uploadsRouter,
  UPLOADS_DIR,
  sanitizeExtension,
  detectCategory,
  extensionForMime,
  isValidStoredFilename,
  sniffContentType,
  BLOCKED_EXTENSIONS,
  MAX_FILE_SIZE,
} from '../src/routes/uploads.js';

test('uploads: утиліти та правила валідації', async (t) => {
  await t.test('sanitizeExtension повертає нормалізоване розширення', () => {
    assert.equal(sanitizeExtension('photo.PNG'), '.png');
    assert.equal(sanitizeExtension('document.PDF'), '.pdf');
    assert.equal(sanitizeExtension('song.mp3'), '.mp3');
    assert.equal(sanitizeExtension('archive.tar.gz'), '.gz');
    assert.equal(sanitizeExtension('no-ext'), '');
    assert.equal(sanitizeExtension(''), '');
    assert.equal(sanitizeExtension(null), '');
    // Небезпечні символи відсікаються
    assert.equal(sanitizeExtension('evil.exe/sub'), '');
  });

  await t.test('detectCategory правильно визначає тип вкладення', () => {
    assert.equal(detectCategory('image/jpeg', '.jpg'), 'image');
    assert.equal(detectCategory('image/png', '.png'), 'image');
    assert.equal(detectCategory('image/webp', '.webp'), 'image');

    assert.equal(detectCategory('audio/mpeg', '.mp3'), 'audio');
    assert.equal(detectCategory('audio/ogg', '.ogg'), 'audio');
    assert.equal(detectCategory('application/octet-stream', '.mp3'), 'audio');
    assert.equal(detectCategory('application/octet-stream', '.wav'), 'audio');

    // Голосові (день 9): mime від MediaRecorder містить codecs-суфікс,
    // але теж має потрапляти в «audio» за префіксом
    assert.equal(detectCategory('audio/webm;codecs=opus', '.webm'), 'audio');
    assert.equal(detectCategory('audio/ogg;codecs=opus', '.ogg'), 'audio');
    assert.equal(detectCategory('audio/mp4', '.m4a'), 'audio');

    assert.equal(detectCategory('video/mp4', '.mp4'), 'video');
    assert.equal(detectCategory('video/webm', '.webm'), 'video');

    assert.equal(detectCategory('application/pdf', '.pdf'), 'file');
    assert.equal(detectCategory('text/plain', '.txt'), 'file');
    assert.equal(detectCategory('application/zip', '.zip'), 'file');
  });

  await t.test('BLOCKED_EXTENSIONS містить основні небезпечні формати', () => {
    assert.ok(BLOCKED_EXTENSIONS.has('.exe'));
    assert.ok(BLOCKED_EXTENSIONS.has('.sh'));
    assert.ok(BLOCKED_EXTENSIONS.has('.bat'));
    assert.ok(BLOCKED_EXTENSIONS.has('.php'));
    assert.ok(BLOCKED_EXTENSIONS.has('.cmd'));
    assert.ok(BLOCKED_EXTENSIONS.has('.ps1'));
    assert.ok(!BLOCKED_EXTENSIONS.has('.png'));
    assert.ok(!BLOCKED_EXTENSIONS.has('.pdf'));
  });

  await t.test('isValidStoredFilename захищає від path traversal', () => {
    assert.equal(isValidStoredFilename('550e8400-e29b-41d4-a716-446655440000.png'), true);
    assert.equal(isValidStoredFilename('valid_file-123.pdf'), true);
    // Файли без розширення (старі голосові) теж валідні — символи виключають шляхи
    assert.equal(isValidStoredFilename('550e8400-e29b-41d4-a716-446655440000'), true);

    // Спроби виходу з каталогу
    assert.equal(isValidStoredFilename('../passwd.txt'), false);
    assert.equal(isValidStoredFilename('..\\windows\\system32'), false);
    assert.equal(isValidStoredFilename('folder/sub.png'), false);
    assert.equal(isValidStoredFilename('file\0.jpg'), false);
    assert.equal(isValidStoredFilename('.'), false);
    assert.equal(isValidStoredFilename(''), false);
    assert.equal(isValidStoredFilename(null), false);
  });

  await t.test('extensionForMime виводить розширення з mime-бази', () => {
    // mime від MediaRecorder містить codecs-суфікс — беремо голу базу
    assert.equal(extensionForMime('audio/webm;codecs=opus'), '.webm');
    assert.equal(extensionForMime('audio/ogg;codecs=opus'), '.ogg');
    assert.equal(extensionForMime('audio/mp4'), '.m4a');
    assert.equal(extensionForMime('image/jpeg'), '.jpg');
    assert.equal(extensionForMime('application/pdf'), '');
    assert.equal(extensionForMime(''), '');
    assert.equal(extensionForMime(undefined), '');
  });

  await t.test('sniffContentType визначає тип за магічними байтами', () => {
    // webm / matroska
    assert.equal(
      sniffContentType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04])),
      'audio/webm',
    );
    assert.equal(sniffContentType(Buffer.from('OggS...........')), 'audio/ogg');
    assert.equal(sniffContentType(Buffer.from('ID3\x03...........')), 'audio/mpeg');
    assert.equal(sniffContentType(Buffer.from('....ftypisom....')), 'video/mp4');
    assert.equal(sniffContentType(Buffer.from('totally not media')), null);
    assert.equal(sniffContentType(Buffer.from('x')), null);
  });
});

test('uploadsRouter HTTP integration tests', async (t) => {
  const app = express();
  app.use(express.json());

  let mockAuthenticatedUser = null;

  // Моковий middleware автентифікації для тестування
  app.use((req, _res, next) => {
    if (mockAuthenticatedUser) {
      req.user = mockAuthenticatedUser;
    }
    next();
  });

  app.use('/api/uploads', uploadsRouter);

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const uploadedFilesToCleanup = [];

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const filename of uploadedFilesToCleanup) {
      try {
        const filePath = path.resolve(UPLOADS_DIR, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {}
    }
  });

  await t.test('POST /api/uploads без авторизації повертає 401', async () => {
    mockAuthenticatedUser = null;
    const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST' });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });

  await t.test('POST /api/uploads з авторизацією але без файлу повертає 400', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    const formData = new FormData();
    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /не передано/i);
  });

  await t.test('POST /api/uploads блокує небезпечні розширення (.exe, .sh)', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    const formData = new FormData();
    formData.append(
      'file',
      new Blob(['binary content'], { type: 'application/x-msdownload' }),
      'malware.exe',
    );

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /заборонено/i);
  });

  await t.test('POST /api/uploads приймає голосове (audio/webm) як вкладення типу «audio»', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    const fakeVoiceBuffer = Buffer.from('1A45DFA3fake webm voice payload');
    const formData = new FormData();
    formData.append('file', new Blob([fakeVoiceBuffer], { type: 'audio/webm' }), 'voice.webm');

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.ok(body.attachment);
    assert.equal(body.attachment.type, 'audio');
    assert.equal(body.attachment.mime, 'audio/webm');
    assert.match(body.attachment.url, /^\/api\/uploads\/files\/[a-zA-Z0-9_-]+\.webm$/);

    uploadedFilesToCleanup.push(body.attachment.url.split('/').pop());
  });

  await t.test('POST /api/uploads виводить розширення з mime, якщо імʼя без нього', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    // Регресія дня 9: браузер надіслав файл без розширення в імені — голосове
    // збереглося як «uuid» без «.webm» і не відтворювалось (<audio> отримував 400)
    const fakeVoiceBuffer = Buffer.from('1A45DFA3fake webm voice payload');
    const formData = new FormData();
    formData.append('file', new Blob([fakeVoiceBuffer], { type: 'audio/webm' }), 'webm');

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.ok(body.attachment);
    assert.equal(body.attachment.type, 'audio');
    assert.match(body.attachment.url, /^\/api\/uploads\/files\/[a-zA-Z0-9_-]+\.webm$/);
    assert.notEqual(body.attachment.url, body.attachment.url.replace('.webm', ''));

    uploadedFilesToCleanup.push(body.attachment.url.split('/').pop());
  });

  await t.test('GET /api/uploads/files/:filename віддає файл без розширення за магічними байтами', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    // Штучно кладемо extensionless-файл (як голосові, збережені до виправлення)
    const legacyName = 'legacy-voice-test-noext';
    const legacyPayload = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('fake webm body for legacy serving test'),
    ]);
    fs.writeFileSync(path.resolve(UPLOADS_DIR, legacyName), legacyPayload);
    uploadedFilesToCleanup.push(legacyName);

    const res = await fetch(`${baseUrl}/api/uploads/files/${legacyName}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/webm');
    assert.match(res.headers.get('cache-control') || '', /immutable/);
    assert.equal(Buffer.from(await res.arrayBuffer()).equals(legacyPayload), true);
  });

  let uploadedAttachment = null;

  await t.test('POST /api/uploads успішно завантажує фото та повертає метадані', async () => {
    mockAuthenticatedUser = { id: 'u-test-1', username: 'tester' };
    const fakeImageBuffer = Buffer.from('fake image content for testing');
    const formData = new FormData();
    formData.append(
      'file',
      new Blob([fakeImageBuffer], { type: 'image/jpeg' }),
      'vacation-photo.jpg',
    );

    const res = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    assert.ok(body.attachment);
    assert.equal(body.attachment.type, 'image');
    assert.equal(body.attachment.name, 'vacation-photo.jpg');
    assert.equal(body.attachment.size, fakeImageBuffer.length);
    assert.equal(body.attachment.mime, 'image/jpeg');
    assert.match(body.attachment.url, /^\/api\/uploads\/files\/[a-zA-Z0-9_-]+\.jpg$/);

    uploadedAttachment = body.attachment;
    const filename = uploadedAttachment.url.split('/').pop();
    uploadedFilesToCleanup.push(filename);
  });

  await t.test('GET /api/uploads/files/:filename віддає файл з правильними заголовками', async () => {
    assert.ok(uploadedAttachment);
    const res = await fetch(`${baseUrl}${uploadedAttachment.url}`);
    assert.equal(res.status, 200);

    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control') || '', /immutable/);

    const content = await res.text();
    assert.equal(content, 'fake image content for testing');
  });

  await t.test('GET /api/uploads/download/:filename формує Content-Disposition для скачування', async () => {
    assert.ok(uploadedAttachment);
    const filename = uploadedAttachment.url.split('/').pop();
    const res = await fetch(
      `${baseUrl}/api/uploads/download/${filename}?name=${encodeURIComponent('скачане_фото.jpg')}`,
    );
    assert.equal(res.status, 200);

    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.match(disposition, /attachment/i);

    const content = await res.text();
    assert.equal(content, 'fake image content for testing');
  });

  await t.test('GET /api/uploads/files/:filename відхиляє некоректні імена та path traversal', async () => {
    const res1 = await fetch(`${baseUrl}/api/uploads/files/invalid..name`);
    assert.equal(res1.status, 400);

    const res2 = await fetch(`${baseUrl}/api/uploads/files/nonexistent-000000000.txt`);
    assert.equal(res2.status, 404);
  });
});

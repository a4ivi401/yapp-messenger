// Голосові повідомлення: рекордер на MediaRecorder + побудова піків хвилі.
// Сервер лише зберігає файл (категорія «audio» вже підтримана) — уся аудіообробка тут,
// без залежностей. Кожне, що браузер не вміє, деградує м'яко (err.code або peaks: false).

// Пріоритет кодеків: opus у webm (Chrome/Edge), opus у ogg (Firefox), AAC у mp4 (Safari/iOS)
const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm',
];

// Розширення файла за mime: важливо, щоб детектор категорії впізнавав його як «audio»
const EXTENSION_BY_MIME = [
  ['audio/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
];

// Перший підтримуваний mime; порожній рядок = дефолт браузера
export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return RECORDER_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) || '';
}

export function extensionForMime(mime) {
  const base = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  const match = EXTENSION_BY_MIME.find(([key]) => base.startsWith(key));
  return match ? match[1] : '';
}

export function isVoiceRecordingSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof window.AudioContext !== 'undefined'
  );
}

function createVoiceError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// Спільний AudioContext: і AnalyserNode запису, і decodeAudioData піків
let sharedAudioCtx = null;
export function getSharedAudioContext() {
  if (!sharedAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new Ctx();
  }
  // Контекст може бути призупинений сторінкою; resume працює лише в межах жесту користувача
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/**
 * Запис голосового. Дозвіл на мікрофон запитується getUserMedia натисканням на кнопку:
 * якщо користувач раніше заборонив — нічого не записуємо (помилка з err.code),
 * після дозволу запис стартує одразу, без другого кліка.
 *
 * stop() резолвиться { blob, extension, durationMs } або null, якщо запис скасовано.
 */
export async function startVoiceRecording() {
  if (!isVoiceRecordingSupported()) throw createVoiceError('unsupported');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      throw createVoiceError('denied');
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      throw createVoiceError('no-mic');
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      throw createVoiceError('busy');
    }
    throw createVoiceError('unknown');
  }

  const mimeType = pickRecorderMime();
  const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  const startedAt = Date.now();
  let discarded = false;
  let settled = null;

  // Аналізатор рівня для «живої» хвилі під час запису (звук нікуди не виводиться)
  const audioCtx = getSharedAudioContext();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(analyser);

  const levels = new Uint8Array(analyser.fftSize);

  /** RMS-рівень мікрофона 0..1 для «живої» хвилі під час запису */
  function getLevel() {
    analyser.getByteTimeDomainData(levels);
    let sum = 0;
    for (let i = 0; i < levels.length; i++) {
      const d = (levels[i] - 128) / 128;
      sum += d * d;
    }
    // Мова типово досягає RMS ~0.25 — підсилюємо, щоб хвиля не виглядала плоскою
    return Math.min(1, 2.5 * Math.sqrt(sum / levels.length));
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    // Мікрофон звільняємо одразу після зупинки запису
    stream.getTracks().forEach((track) => track.stop());
    try {
      source.disconnect();
    } catch {}
    const blob =
      discarded || chunks.length === 0
        ? null
        : new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    settled?.({
      blob,
      extension: blob ? extensionForMime(mediaRecorder.mimeType) : '',
      durationMs: Date.now() - startedAt,
    });
  };

  mediaRecorder.onerror = () => {
    discarded = true;
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  };

  mediaRecorder.start();

  return {
    startedAt,
    getLevel,
    /** Результат запису; повторний виклик результату не повторює */
    stop: () => {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      return new Promise((resolve) => {
        settled = resolve;
      });
    },
    /** Скасувати запис: звук викидається, результат — null */
    cancel: () => {
      discarded = true;
      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      } else {
        settled?.(null);
      }
    },
  };
}

// ================= Довжина та піки отриманих голосових =================

// Відома особливість Chrome: webm від MediaRecorder без Cues-секцій віддає
// duration = Infinity у метаданих <audio>. Надійна довжина — із декодованого AudioBuffer,
// тому вона зберігається в одному кеші з піками.
export const PEAK_BARS = 48;

const waveCache = new Map(); // url → { peaks: number[] | false, duration: number | null }

export function cachedWave(url) {
  return waveCache.get(url) ?? null;
}

/**
 * Лінива розбудова хвилі: перший рендер фетчить + декодує файл, далі значення з кешу.
 * peaks === false означає: декод не вдався (webm не читається в Safari) — хвиля
 * деградує до прогрес-бара, звук грає як звично через <audio>.
 */
export async function loadWave(url, bars = PEAK_BARS) {
  const cached = waveCache.get(url);
  if (cached) return cached;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const audioBuffer = await getSharedAudioContext().decodeAudioData(await res.arrayBuffer());
    const channelData = audioBuffer.getChannelData(0);

    const step = Math.max(1, Math.floor(channelData.length / bars));
    const rawPeaks = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      for (
        let sample = i * step;
        sample < Math.min((i + 1) * step, channelData.length);
        sample += 8
      ) {
        const amplitude = Math.abs(channelData[sample]);
        if (amplitude > max) max = amplitude;
      }
      rawPeaks.push(max);
    }
    // Нормалізуємо до 0..1 відносно найгучнішого піку
    const globalMax = Math.max(...rawPeaks, 1e-6);
    const wave = {
      peaks: rawPeaks.map((value) => value / globalMax),
      duration: Number.isFinite(audioBuffer.duration) ? audioBuffer.duration : null,
    };
    waveCache.set(url, wave);
    return wave;
  } catch (err) {
    console.error('Failed to decode voice wave:', err);
    const wave = { peaks: false, duration: null };
    waveCache.set(url, wave);
    return wave;
  }
}

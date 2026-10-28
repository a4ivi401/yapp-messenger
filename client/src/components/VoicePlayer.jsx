import { useEffect, useRef, useState } from 'react';
import { cachedWave, loadWave } from '../utils/voice.js';

// Довжина у форматі m:ss
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Бульбашка голосового повідомлення (тип «audio»): щира хвиля + плеер.
 * Піки будуються з декодованого файла (WebAudio) і кешуються за url —
 * якщо браузер не вміє декодувати (webm у Safari) або Chrome віддає
 * duration = Infinity, показуємо деградацію (прогрес без піків),
 * звук грає як звично через <audio>.
 *
 * Кольори (прогрес/решта) беремо з CSS-змінних --voice-done / --voice-rest,
 * у вихідних повідомленнях їх перевизначає .message-out .attachment-voice.
 */
export default function VoicePlayer({ attachment }) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);

  // null — хвиля ще не готова, { peaks, duration } — готова; peaks: false — деградація
  const [wave, setWave] = useState(() => cachedWave(attachment.url));
  const [isPlaying, setIsPlaying] = useState(false);
  // Помилка відтворення (браузер не читає контейнер — наприклад, webm у Safari):
  // замінюємо плеер на плашку з посиланням на завантаження
  const [playbackFailed, setPlaybackFailed] = useState(false);
  // Довжина, яку надійно віддає браузер: метадані <audio> або декодований буфер
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);

  // Ліниве декодування: раз на url, далі значення з кешу модуля
  useEffect(() => {
    let alive = true;
    loadWave(attachment.url).then((result) => {
      if (alive) setWave(result);
    });
    return () => {
      alive = false;
    };
  }, [attachment.url]);

  // Довжина: спочатку метадані, якщо Infinity (Chrome + webm від MediaRecorder) — з кешу
  useEffect(() => {
    if (wave?.duration) setDuration(wave.duration);
  }, [wave]);

  // Позиція відтворення — по rAF, доки грає
  useEffect(() => {
    if (!isPlaying) return undefined;
    let frame;
    const tick = () => {
      if (audioRef.current) setPosition(audioRef.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [isPlaying]);

  const effectiveDuration = duration > 0 ? duration : 0;
  const progress = effectiveDuration > 0 ? Math.min(1, position / effectiveDuration) : 0;

  // Отримання хвилі: кольори з CSS-змінних (--voice-done / --voice-rest), для вхідних
  // повідомлень вони перевизначаються у .message-out .attachment-voice
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const css = getComputedStyle(canvas);
    const doneColor = css.getPropertyValue('--voice-done').trim() || 'currentColor';
    const restColor = css.getPropertyValue('--voice-rest').trim() || 'rgba(0,0,0,0.15)';

    const peaks = wave?.peaks;

    if (peaks === false) {
      // Деградація без піків: рівна полоска прогресу
      ctx.fillStyle = restColor;
      ctx.fillRect(0, height / 2 - 2, width, 4);
      if (progress > 0) {
        ctx.fillStyle = doneColor;
        ctx.fillRect(0, height / 2 - 2, width * progress, 4);
      }
      return;
    }

    if (!Array.isArray(peaks)) {
      // Хвиля ще декодується: нейтральна тонка лінія
      ctx.fillStyle = restColor;
      ctx.fillRect(0, height / 2 - 1, 4, 2);
      return;
    }

    // Щира хвиля — вертикальні штрихи піків; прогрес зафарбовує пройдену частину
    const barCount = peaks.length;
    const gap = 2;
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    const playedBars = Math.floor(barCount * progress);
    for (let i = 0; i < barCount; i++) {
      const barHeight = 3 + peaks[i] * (height - 5);
      const x = i * (barWidth + gap);
      const y = (height - barHeight) / 2;
      ctx.fillStyle = i <= playedBars ? doneColor : restColor;
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }, [wave, progress]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((err) => console.error('Voice playback failed:', err));
    }
  };

  // Перемотка: клік по хвилі → позиція за координатою кліку
  const handleSeek = (e) => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas || effectiveDuration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = fraction * effectiveDuration;
    setPosition(audio.currentTime);
  };

  if (playbackFailed) {
    const downloadUrl = `/api/uploads/download/${attachment.url.split('/').pop()}?name=${encodeURIComponent(attachment.name || 'voice')}`;
    return (
      <div className="attachment-voice is-unplayable">
        <span className="voice-unplayable-icon" aria-hidden="true">🎤</span>
        <a href={downloadUrl} download className="voice-unplayable-link" title="Завантажити голосове">
          Голосове не відтворюється в цьому браузері — завантажити файл
        </a>
      </div>
    );
  }

  return (
    <div className="attachment-voice">
      <button
        type="button"
        className="voice-play-btn"
        onClick={togglePlayback}
        title={isPlaying ? 'Пауза' : 'Прослухати'}
        aria-label={isPlaying ? 'Пауза' : 'Прослухати'}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <canvas
        ref={canvasRef}
        className="voice-canvas"
        onClick={handleSeek}
        title="Натисніть для перемотки"
      />
      <span className="voice-duration">
        {formatDuration(isPlaying ? position : effectiveDuration)}
      </span>
      {/* Прихований <audio>: тривалість з метаданих, звук грає він сам */}
      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const raw = e.currentTarget.duration;
          if (Number.isFinite(raw)) setDuration(raw);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onError={() => setPlaybackFailed(true)}
        onEnded={() => {
          setIsPlaying(false);
          setPosition(0);
        }}
      />
    </div>
  );
}

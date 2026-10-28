import { useEffect, useRef, useState } from 'react';

// Таймер панелі запису: частота оновлення секунди живої хвилі та лічильника
const ELAPSED_REFRESH_MS = 250; // наближаємо до 4 кадрів на секунду — плавно й дешево
const LIVE_BARS = 40;           // стільки смуг історії рівнів видно у «живій» хвилі

// Довжина у форматі m:ss
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Панель активного запису: пульсуюча точка + лічильник + «жива» хвиля мікрофона
 * + кнопки скасувати (✕) / надіслати. Хвиля — історія RMS-рівнів рекордера,
 * зрушена праворуч (нові смуги з'являються праворуч, як у Telegram).
 */
export default function VoiceRecordingBar({ recorder, onSend, onCancel }) {
  const canvasRef = useRef(null);
  const historyRef = useRef([]);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Жива хвиля: на кожному кадрі читаємо рівень мікрофона й малюємо історію смуг
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !recorder) return undefined;
    let frame;
    let lastElapsedRefresh = 0;

    const tick = (now) => {
      const level = recorder.getLevel();
      const history = historyRef.current;
      history.push(level);
      while (history.length > LIVE_BARS) history.shift();

      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      if (width > 0 && height > 0) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.scale(dpr, dpr);
          const css = getComputedStyle(canvas);
          const barColor = css.getPropertyValue('--voice-done').trim() || 'currentColor';
          const bg = css.getPropertyValue('--voice-rest').trim() || 'rgba(0,0,0,0.12)';

          const gap = 2;
          const barWidth = Math.max(2, (width - gap * (LIVE_BARS - 1)) / LIVE_BARS);
          for (let i = 0; i < LIVE_BARS; i++) {
            const x = i * (barWidth + gap);
            // Незаповнена історія — сіра базова лінія, щоб панель не «мигала»
            const value = i < history.length ? history[i] : 0;
            const barHeight = 2 + value * (height - 4);
            ctx.fillStyle = i < history.length ? barColor : bg;
            ctx.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
          }
        }
      }

      // Лічильник оновлюємо рідше самого кадру — 4 рази на секунду досить
      if (now - lastElapsedRefresh >= ELAPSED_REFRESH_MS) {
        lastElapsedRefresh = now;
        setElapsedMs(Date.now() - recorder.startedAt);
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recorder]);

  return (
    <div className="voice-recording-bar">
      <span className="voice-record-dot" aria-hidden="true" />
      <span className="voice-record-time">{formatDuration(elapsedMs / 1000)}</span>
      <canvas ref={canvasRef} className="voice-live-canvas" aria-hidden="true" />
      <button
        type="button"
        className="voice-cancel-btn"
        onClick={onCancel}
        title="Скасувати запис"
        aria-label="Скасувати запис"
      >
        ✕
      </button>
      <button
        type="button"
        className="voice-send-btn"
        onClick={onSend}
        title="Надіслати голосове"
        aria-label="Надіслати голосове"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
        </svg>
      </button>
    </div>
  );
}

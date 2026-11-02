import React from 'react';

/**
 * Yapp Brand Logo Component
 * Concept: "Duo Dialogue" (interlocking conversation speech bubbles)
 * Flat, solid colors: Electric Violet (#7C3AED) & Vibrant Cyan (#06B6D4 / #22D3EE)
 * Zero letters, zero gradients.
 *
 * @param {number} size - Pixel size (width/height) of the icon mark
 * @param {string} className - Additional CSS class
 * @param {'badge' | 'glyph'} variant - 'badge' (app icon squircle) or 'glyph' (transparent mark)
 * @param {boolean} showWordmark - Whether to render the 'Yapp' typography
 * @param {number} wordmarkSize - Font size of the 'Yapp' wordmark
 * @param {string} tagline - Optional subtitle under the wordmark
 */
export default function Logo({
  size = 36,
  className = '',
  variant = 'badge',
  showWordmark = false,
  wordmarkSize = 24,
  tagline = null
}) {
  return (
    <div
      className={`yapp-logo-lockup ${className}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: Math.max(8, Math.round(size * 0.28)),
        userSelect: 'none'
      }}
    >
      {variant === 'badge' ? (
        <div
          className="yapp-logo-badge"
          style={{
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.24),
            background: '#7C3AED',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            flexShrink: 0,
            boxShadow: '0 4px 16px rgba(124, 58, 237, 0.28)'
          }}
        >
          <svg
            viewBox="0 0 100 100"
            width={size}
            height={size}
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            {/* Back Bubble (Cyan - stranger/companion) */}
            <path
              d="M 42 18 C 42 11, 48 6, 58 6 L 76 6 C 85 6, 91 12, 91 21 L 91 42 C 91 51, 85 57, 76 57 L 73 57 L 81 67 C 82.2 68.5, 80.2 70, 78.8 69 L 66 59 C 63.5 60, 61 60, 58 60 C 48 60, 42 54, 42 45 Z"
              fill="#22D3EE"
            />
            {/* Front Bubble (Pure White with #7C3AED stroke to separate cleanly from cyan bubble) */}
            <path
              d="M 12 34 C 12 24, 20 16, 30 16 L 58 16 C 68 16, 76 24, 76 34 L 76 56 C 76 66, 68 74, 58 74 L 38 74 L 20 88 C 18.2 89.4, 16 88, 16.5 85.8 L 17.5 74 C 13.5 70.8, 12 65, 12 56 Z"
              fill="#FFFFFF"
              stroke="#7C3AED"
              strokeWidth="7"
              strokeLinejoin="round"
            />
            {/* 3 Bold Violet Speech Dots */}
            <circle cx="30" cy="45" r="5.2" fill="#7C3AED" />
            <circle cx="44" cy="45" r="5.2" fill="#7C3AED" />
            <circle cx="58" cy="45" r="5.2" fill="#7C3AED" />
          </svg>
        </div>
      ) : (
        <svg
          viewBox="0 0 100 100"
          width={size}
          height={size}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0 }}
        >
          <defs>
            <mask id={`glyph-mask-${size}`}>
              <rect width="100" height="100" fill="white" />
              <path
                d="M 10 34 C 10 22, 19 14, 32 14 L 62 14 C 74 14, 83 22, 83 34 L 83 58 C 83 70, 74 78, 62 78 L 40 78 L 20 94 C 18 95.5, 15.5 94, 16.2 91.5 L 17.5 78 C 12 74.5, 10 67.5, 10 58 Z"
                fill="black"
                stroke="black"
                strokeWidth="9"
                strokeLinejoin="round"
              />
            </mask>
          </defs>
          {/* Back Bubble (Cyan) */}
          <path
            d="M 44 16 C 44 8, 52 4, 63 4 L 81 4 C 91 4, 98 12, 98 22 L 98 46 C 98 56, 91 63, 81 63 L 78 63 L 87 74 C 88.5 75.8, 86 77.5, 84.5 76.2 L 70 65 C 67 66, 64 66, 61 66 C 50 66, 44 58, 44 48 Z"
            fill="#06B6D4"
            mask={`url(#glyph-mask-${size})`}
          />
          {/* Front Bubble (Violet) */}
          <path
            d="M 10 34 C 10 22, 19 14, 32 14 L 62 14 C 74 14, 83 22, 83 34 L 83 58 C 83 70, 74 78, 62 78 L 40 78 L 20 94 C 18 95.5, 15.5 94, 16.2 91.5 L 17.5 78 C 12 74.5, 10 67.5, 10 58 Z"
            fill="#7C3AED"
          />
          {/* 3 White Speech Dots */}
          <circle cx="32" cy="46" r="5.5" fill="#FFFFFF" />
          <circle cx="47" cy="46" r="5.5" fill="#FFFFFF" />
          <circle cx="62" cy="46" r="5.5" fill="#FFFFFF" />
        </svg>
      )}

      {showWordmark && (
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span
            style={{
              fontSize: wordmarkSize,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              color: 'var(--ink, #1b1b22)'
            }}
          >
            Yapp
          </span>
          {tagline && (
            <span
              style={{
                fontSize: Math.round(wordmarkSize * 0.42),
                fontWeight: 700,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--muted, #6e6e7a)',
                marginTop: 2
              }}
            >
              {tagline}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

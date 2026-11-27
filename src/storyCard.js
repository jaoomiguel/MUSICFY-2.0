const STORY_WIDTH = 1080;
const STORY_HEIGHT = 1920;

export const STORY_THEMES = [
  { id: 'aura', label: 'Aura Glass', description: 'Vidro escuro luminoso' },
  { id: 'aero', label: 'Aero Claro', description: 'Brilho Frutiger Aero' },
  { id: 'vinyl', label: 'Vinil Noturno', description: 'Capa com disco de vinil' },
];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const parseHex = (hex, fallback = '#31b6c5') => {
  const clean = typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex.trim())
    ? hex.trim()
    : fallback;
  return {
    r: parseInt(clean.slice(1, 3), 16),
    g: parseInt(clean.slice(3, 5), 16),
    b: parseInt(clean.slice(5, 7), 16),
  };
};

const rgba = (hex, alpha) => {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
};

const mixRgb = (hexA, hexB, weight = 0.5) => {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  const t = clamp(weight, 0, 1);
  return `rgb(${Math.round(a.r * (1 - t) + b.r * t)}, ${Math.round(a.g * (1 - t) + b.g * t)}, ${Math.round(a.b * (1 - t) + b.b * t)})`;
};

const rgbToHsl = (hex) => {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }

  return { h: h * 360, s: s * 100, l: l * 100 };
};

const hslToHex = (h, s, l) => {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const hue2rgb = (p, q, t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  let r;
  let g;
  let b;
  if (sat === 0) {
    r = light;
    g = light;
    b = light;
  } else {
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    r = hue2rgb(p, q, hue + 1 / 3);
    g = hue2rgb(p, q, hue);
    b = hue2rgb(p, q, hue - 1 / 3);
  }

  const toHex = (value) => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

const getDominantColor = (image) => {
  if (!image || !image.naturalWidth || !image.naturalHeight) return null;
  try {
    const size = 28;
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = size;
    sampleCanvas.height = size;
    const sampleCtx = sampleCanvas.getContext('2d');
    if (!sampleCtx) return null;
    sampleCtx.drawImage(image, 0, 0, size, size);
    const { data } = sampleCtx.getImageData(0, 0, size, size);

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 128) continue;
      const pr = data[i];
      const pg = data[i + 1];
      const pb = data[i + 2];
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      if (max > 244 && min > 244) continue;
      if (max < 16) continue;
      r += pr;
      g += pg;
      b += pb;
      count += 1;
    }
    if (!count) return null;

    const average = `#${[r, g, b]
      .map((value) => Math.round(value / count).toString(16).padStart(2, '0'))
      .join('')}`;
    const { h, s, l } = rgbToHsl(average);
    return hslToHex(h, clamp(s * 1.2, 24, 92), clamp(l, 26, 58));
  } catch {
    return null;
  }
};

const loadImageDirect = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Image load failed'));
  image.src = src;
});

const loadStoryImage = async (src) => {
  if (!src || typeof src !== 'string') return null;
  const trimmed = src.trim();
  if (!trimmed) return null;

  try {
    return await loadImageDirect(trimmed);
  } catch {
    if (!/^https?:\/\//i.test(trimmed)) return null;
    try {
      const apiBase = import.meta.env.VITE_API_URL || '/api';
      const proxyUrl = `${apiBase.replace(/\/$/, '')}/story-image?url=${encodeURIComponent(trimmed)}`;
      return await loadImageDirect(proxyUrl);
    } catch {
      return null;
    }
  }
};

const roundedRectPath = (ctx, x, y, width, height, radius) => {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
};

const drawCoverImage = (ctx, image, x, y, width, height, radius, fallbackAccent) => {
  ctx.save();
  roundedRectPath(ctx, x, y, width, height, radius);
  ctx.clip();

  if (image && image.naturalWidth && image.naturalHeight) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawW = image.naturalWidth * scale;
    const drawH = image.naturalHeight * scale;
    ctx.drawImage(image, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH);
  } else {
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, mixRgb(fallbackAccent, '#111927', 0.35));
    gradient.addColorStop(1, mixRgb(fallbackAccent, '#090d14', 0.72));
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.font = '700 124px "SF Pro Display", "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♫', x + width / 2, y + height / 2);
  }

  ctx.restore();
};

const wrapLines = (ctx, text, maxWidth, maxLines) => {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const words = cleaned.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width <= maxWidth) {
      currentLine = testLine;
    } else if (currentLine) {
      lines.push(currentLine);
      currentLine = word;
      if (lines.length === maxLines) break;
    } else {
      let truncated = word;
      while (truncated.length > 1 && ctx.measureText(`${truncated}…`).width > maxWidth) {
        truncated = truncated.slice(0, -1);
      }
      lines.push(`${truncated}…`);
      currentLine = '';
      if (lines.length === maxLines) break;
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  } else if (currentLine && lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last.replace(/[.,;:!?…]+$/, '')}…`;
  }

  return lines;
};

const drawTruncatedText = (ctx, text, x, y, maxWidth) => {
  const value = String(text || '').trim();
  if (!value) return;
  if (ctx.measureText(value).width <= maxWidth) {
    ctx.fillText(value, x, y);
    return;
  }
  let shortened = value;
  while (shortened.length > 1 && ctx.measureText(`${shortened}…`).width > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  ctx.fillText(`${shortened.trimEnd()}…`, x, y);
};

const drawVinylDisc = (ctx, cx, cy, radius, accentColor) => {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = 42;
  ctx.shadowOffsetX = 12;
  ctx.shadowOffsetY = 18;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  const discGrad = ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, radius * 0.1, cx, cy, radius);
  discGrad.addColorStop(0, '#2a303b');
  discGrad.addColorStop(0.65, '#11141a');
  discGrad.addColorStop(1, '#07090d');
  ctx.fillStyle = discGrad;
  ctx.fill();
  ctx.restore();

  ctx.save();
  for (let r = radius * 0.44; r < radius * 0.94; r += 20) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.33, 0, Math.PI * 2);
  ctx.fillStyle = mixRgb(accentColor, '#141923', 0.25);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = '#090d14';
  ctx.fill();
  ctx.restore();
};

const getRatingPalette = (rating) => {
  const score = Number(rating || 0);
  if (score >= 8) return { bg: '#22c55e', fg: '#052e16', glow: 'rgba(34, 197, 94, 0.36)' };
  if (score >= 6) return { bg: '#f59e0b', fg: '#2b1600', glow: 'rgba(245, 158, 11, 0.34)' };
  return { bg: '#ef4444', fg: '#fff1f2', glow: 'rgba(239, 68, 68, 0.34)' };
};

export async function renderStoryCard({ review, themeId = 'aura', showQuote = true, fallbackCover = '' }) {
  const [coverImage, avatarImage] = await Promise.all([
    loadStoryImage(review?.release_cover || fallbackCover),
    loadStoryImage(review?.avatar_url),
  ]);

  const configuredAccent = review?.release_accent_color || review?.accent_color || review?.artist_accent_color;
  const accentColor = configuredAccent || getDominantColor(coverImage) || '#31b6c5';
  const accentHsl = rgbToHsl(accentColor);
  const accentTop = hslToHex(
    accentHsl.h,
    clamp(accentHsl.s * 1.02, 24, 94),
    clamp(accentHsl.l * 0.94, 22, 52),
  );
  const accentMid = hslToHex(
    accentHsl.h,
    clamp(accentHsl.s * 0.9, 22, 88),
    clamp(accentHsl.l * 0.56, 12, 34),
  );
  const accentBottom = hslToHex(
    accentHsl.h,
    clamp(accentHsl.s * 0.82, 18, 82),
    clamp(accentHsl.l * 0.32, 7, 20),
  );
  const accentGlow = hslToHex(
    accentHsl.h,
    clamp(accentHsl.s * 1.05, 26, 94),
    clamp(accentHsl.l * 0.78, 24, 56),
  );

  const canvas = document.createElement('canvas');
  canvas.width = STORY_WIDTH;
  canvas.height = STORY_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D não disponível neste navegador.');

  const isLight = themeId === 'aero';
  const isVinyl = themeId === 'vinyl';

  // 1. Background sky / aura gradient (derived from the album accent)
  const bgGradient = ctx.createLinearGradient(0, 0, STORY_WIDTH, STORY_HEIGHT);
  if (isLight) {
    bgGradient.addColorStop(0, hslToHex(accentHsl.h, clamp(accentHsl.s * 0.65, 14, 62), 93));
    bgGradient.addColorStop(0.52, hslToHex(accentHsl.h, clamp(accentHsl.s * 0.5, 10, 48), 96));
    bgGradient.addColorStop(1, hslToHex(accentHsl.h, clamp(accentHsl.s * 0.6, 12, 58), 87));
  } else if (isVinyl) {
    bgGradient.addColorStop(0, accentTop);
    bgGradient.addColorStop(0.52, accentMid);
    bgGradient.addColorStop(1, accentBottom);
  } else {
    bgGradient.addColorStop(0, accentTop);
    bgGradient.addColorStop(0.5, accentMid);
    bgGradient.addColorStop(1, accentBottom);
  }
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, STORY_WIDTH, STORY_HEIGHT);

  // Ambient aura orbs (same hue as the album accent)
  const drawOrb = (ox, oy, radius, color, alpha) => {
    const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, radius);
    grad.addColorStop(0, rgba(color, alpha));
    grad.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(ox - radius, oy - radius, radius * 2, radius * 2);
  };
  drawOrb(190, 260, 620, accentColor, isLight ? 0.28 : 0.4);
  drawOrb(910, 1520, 680, isLight ? accentColor : accentGlow, isLight ? 0.3 : 0.28);
  drawOrb(840, 420, 440, isLight ? accentGlow : accentTop, isLight ? 0.22 : 0.18);

  // Top brand pill
  ctx.save();
  const topPillW = 360;
  const topPillH = 66;
  const topPillX = (STORY_WIDTH - topPillW) / 2;
  const topPillY = 128;
  roundedRectPath(ctx, topPillX, topPillY, topPillW, topPillH, 33);
  ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.08)';
  ctx.fill();
  ctx.strokeStyle = isLight ? 'rgba(26, 38, 54, 0.12)' : 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = isLight ? '#1a2636' : '#f5f7ff';
  ctx.font = '800 24px "SF Pro Display", "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♫   RESENHA NO MUSICFY', STORY_WIDTH / 2, topPillY + topPillH / 2 + 1);
  ctx.restore();

  // 2. Central frosted glass card
  const cardX = 86;
  const cardY = 238;
  const cardW = STORY_WIDTH - cardX * 2;
  const cardH = 1368;
  const cardRadius = 56;

  ctx.save();
  ctx.shadowColor = isLight ? 'rgba(26, 46, 70, 0.16)' : 'rgba(0, 0, 0, 0.56)';
  ctx.shadowBlur = 72;
  ctx.shadowOffsetY = 28;
  roundedRectPath(ctx, cardX, cardY, cardW, cardH, cardRadius);
  const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
  if (isLight) {
    cardGrad.addColorStop(0, 'rgba(255, 255, 255, 0.90)');
    cardGrad.addColorStop(1, 'rgba(241, 247, 252, 0.76)');
  } else {
    cardGrad.addColorStop(0, rgba(hslToHex(accentHsl.h, clamp(accentHsl.s * 0.6, 16, 64), clamp(accentHsl.l * 0.4, 10, 26)), 0.9));
    cardGrad.addColorStop(1, rgba(hslToHex(accentHsl.h, clamp(accentHsl.s * 0.5, 14, 58), clamp(accentHsl.l * 0.22, 6, 15)), 0.88));
  }
  ctx.fillStyle = cardGrad;
  ctx.fill();
  ctx.restore();

  // Glass border + specular Frutiger Aero highlight at top of card
  ctx.save();
  roundedRectPath(ctx, cardX, cardY, cardW, cardH, cardRadius);
  ctx.strokeStyle = isLight ? rgba(accentColor, 0.34) : rgba(accentColor, 0.42);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.clip();
  const shineGrad = ctx.createLinearGradient(0, cardY, 0, cardY + 280);
  shineGrad.addColorStop(0, isLight ? 'rgba(255, 255, 255, 0.72)' : 'rgba(255, 255, 255, 0.14)');
  shineGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = shineGrad;
  ctx.fillRect(cardX, cardY, cardW, 280);
  ctx.restore();

  // 3. Album cover (with optional vinyl disc peeking out)
  const coverSize = isVinyl ? 560 : 640;
  const coverX = isVinyl ? cardX + 94 : (STORY_WIDTH - coverSize) / 2;
  const coverY = cardY + 86;

  if (isVinyl) {
    drawVinylDisc(ctx, coverX + coverSize - 10, coverY + coverSize / 2, coverSize * 0.45, accentColor);
  }

  ctx.save();
  ctx.shadowColor = rgba(accentColor, isLight ? 0.32 : 0.42);
  ctx.shadowBlur = 54;
  ctx.shadowOffsetY = 24;
  roundedRectPath(ctx, coverX, coverY, coverSize, coverSize, 38);
  ctx.fillStyle = '#0f1622';
  ctx.fill();
  ctx.restore();

  drawCoverImage(ctx, coverImage, coverX, coverY, coverSize, coverSize, 38, accentColor);

  ctx.save();
  roundedRectPath(ctx, coverX, coverY, coverSize, coverSize, 38);
  ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // 4. Title, Artist & Rating pill
  const contentX = cardX + 74;
  const contentW = cardW - 148;
  const metaY = coverY + coverSize + 64;

  const scoreValue = Number(review?.rating ?? 0);
  const ratingPalette = getRatingPalette(scoreValue);
  const badgeW = 148;
  const badgeH = 74;
  const badgeX = cardX + cardW - 74 - badgeW;
  const badgeY = metaY - 6;

  ctx.save();
  ctx.shadowColor = ratingPalette.glow;
  ctx.shadowBlur = 24;
  roundedRectPath(ctx, badgeX, badgeY, badgeW, badgeH, 24);
  ctx.fillStyle = ratingPalette.bg;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.fillStyle = ratingPalette.fg;
  ctx.font = '800 34px "SF Pro Display", "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${scoreValue}/10`, badgeX + badgeW / 2, badgeY + badgeH / 2 + 2);
  ctx.restore();

  const textColW = contentW - badgeW - 28;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = isLight ? '#152232' : '#f5f7ff';
  ctx.font = '800 48px "SF Pro Display", "Segoe UI", Arial, sans-serif';
  drawTruncatedText(ctx, review?.release_title || 'Lançamento', contentX, metaY - 4, textColW);

  ctx.fillStyle = isLight ? '#526277' : '#a7b0c3';
  ctx.font = '600 32px "SF Pro Text", "Segoe UI", Arial, sans-serif';
  drawTruncatedText(ctx, review?.artist_name || 'Artista', contentX, metaY + 58, textColW);
  ctx.restore();

  // Divider line
  const dividerY = metaY + 124;
  ctx.save();
  ctx.strokeStyle = isLight ? 'rgba(26, 38, 54, 0.1)' : 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(contentX, dividerY);
  ctx.lineTo(contentX + contentW, dividerY);
  ctx.stroke();
  ctx.restore();

  // 5. Quote / Review text
  const rawQuote = showQuote ? String(review?.review_text || '').trim() : '';
  const quoteText = rawQuote || `Deu nota ${scoreValue}/10 para este lançamento no Musicfy.`;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = rgba(accentColor, isLight ? 0.85 : 0.9);
  ctx.font = '800 58px Georgia, serif';
  ctx.fillText('“', contentX - 4, dividerY + 28);

  ctx.fillStyle = isLight ? '#1e2c3d' : '#eef2ff';
  ctx.font = rawQuote.length > 170
    ? '500 31px "SF Pro Text", "Segoe UI", Arial, sans-serif'
    : '500 36px "SF Pro Text", "Segoe UI", Arial, sans-serif';
  const lineHeight = rawQuote.length > 170 ? 45 : 52;
  const maxLines = rawQuote.length > 170 ? 5 : 4;
  const quoteLines = wrapLines(ctx, quoteText, contentW - 8, maxLines);
  quoteLines.forEach((line, index) => {
    ctx.fillText(line, contentX, dividerY + 86 + index * lineHeight);
  });
  ctx.restore();

  // 6. Author row at bottom of glass card
  const authorY = cardY + cardH - 128;
  const avatarSize = 76;
  ctx.save();
  roundedRectPath(ctx, contentX, authorY, avatarSize, avatarSize, avatarSize / 2);
  ctx.clip();
  if (avatarImage && avatarImage.naturalWidth) {
    const scale = Math.max(avatarSize / avatarImage.naturalWidth, avatarSize / avatarImage.naturalHeight);
    const dw = avatarImage.naturalWidth * scale;
    const dh = avatarImage.naturalHeight * scale;
    ctx.drawImage(avatarImage, contentX + (avatarSize - dw) / 2, authorY + (avatarSize - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = rgba(accentColor, 0.35);
    ctx.fillRect(contentX, authorY, avatarSize, avatarSize);
    ctx.fillStyle = isLight ? '#152232' : '#ffffff';
    ctx.font = '700 32px "SF Pro Display", "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = (review?.full_name || review?.username || 'M').slice(0, 1).toUpperCase();
    ctx.fillText(initial, contentX + avatarSize / 2, authorY + avatarSize / 2 + 2);
  }
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, contentX, authorY, avatarSize, avatarSize, avatarSize / 2);
  ctx.strokeStyle = rgba(accentColor, 0.55);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = isLight ? '#152232' : '#f5f7ff';
  ctx.font = '700 30px "SF Pro Display", "Segoe UI", Arial, sans-serif';
  drawTruncatedText(ctx, review?.full_name || review?.username || 'Ouvinte', contentX + avatarSize + 22, authorY + 6, contentW - avatarSize - 32);

  ctx.fillStyle = isLight ? '#526277' : '#a7b0c3';
  ctx.font = '500 24px "SF Pro Text", "Segoe UI", Arial, sans-serif';
  drawTruncatedText(ctx, `@${review?.username || 'musicfy'}`, contentX + avatarSize + 22, authorY + 42, contentW - avatarSize - 32);
  ctx.restore();

  // 7. Bottom CTA / Musicfy wordmark for Instagram discovery
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = isLight ? '#152232' : '#ffffff';
  ctx.font = '800 42px "SF Pro Display", "Segoe UI", Arial, sans-serif';
  ctx.fillText('musicfy', STORY_WIDTH / 2, 1666);

  ctx.fillStyle = isLight ? '#4f6075' : '#a7b0c3';
  ctx.font = '600 26px "SF Pro Text", "Segoe UI", Arial, sans-serif';
  ctx.fillText('Avalie álbuns, crie playlists e compartilhe com amigos', STORY_WIDTH / 2, 1724);
  ctx.restore();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Não foi possível gerar a imagem do Story.');

  return {
    blob,
    dataUrl: canvas.toDataURL('image/png'),
  };
}

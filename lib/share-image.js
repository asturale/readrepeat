import sharp from 'sharp';

const WIDTH = 1080;
const HEIGHT = 1350;
const COVER_WIDTH = 420;
const MARGIN = 60;
const FADE_WIDTH = 140;

// Fallback palette (no cover, or cover fetch/analysis failed) -- the
// original fixed navy theme.
const DEFAULT_BG_TOP = '#1b2430';
const DEFAULT_BG_BOTTOM = '#141b25';
const DEFAULT_ACCENT = '#e0c419';

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        switch (max) {
            case r: h = ((g - b) / d) % 6; break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    return [h, s, l];
}

function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const toHex = (v) => Math.max(0, Math.min(255, Math.round((v + m) * 255))).toString(16).padStart(2, '0');
    return '#' + [r, g, b].map(toHex).join('');
}

// sharp's own stats().dominant is the single most-frequent PIXEL color --
// for most book covers that's the white/cream page margin, not the cover
// art's actual color identity (confirmed: a mostly-white cover with blue
// title text came back essentially as {248,248,248}, i.e. no usable hue at
// all). So instead: downsample to a small thumbnail, convert every pixel to
// HSL, throw out near-grayscale/near-white/near-black pixels (the margin/
// background), and bucket the REMAINING colorful pixels by hue to find
// which hue actually dominates the artwork.
async function extractCoverHue(coverSharp) {
    const { data, info } = await coverSharp
        .clone()
        .resize(48, 48, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const BUCKETS = 24; // 15-degree hue buckets
    const bucketCount = new Array(BUCKETS).fill(0);
    const bucketSat = new Array(BUCKETS).fill(0);
    for (let i = 0; i + 2 < data.length; i += channels) {
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (s < 0.15 || l < 0.08 || l > 0.92) continue; // background/margin, not the art's color
        const bucket = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
        bucketCount[bucket]++;
        bucketSat[bucket] += s;
    }
    let best = -1, bestCount = 0;
    for (let i = 0; i < BUCKETS; i++) {
        if (bucketCount[i] > bestCount) { bestCount = bucketCount[i]; best = i; }
    }
    if (best === -1) return null; // genuinely grayscale/neutral cover -- caller falls back to the default palette
    return { h: best * (360 / BUCKETS) + 360 / BUCKETS / 2, s: bucketSat[best] / bucketCount[best] };
}

// Derives a background gradient + accent color from the cover's actual
// dominant hue (see extractCoverHue) -- forces lightness down to a narrow
// dark range regardless of the source color, so white body text always
// stays readable no matter how bright/saturated the cover art itself is.
function paletteFromHue({ h, s }) {
    const sat = Math.min(Math.max(s, 0.3), 0.7);
    return {
        bgTop: hslToHex(h, sat, 0.16),
        bgBottom: hslToHex(h, sat, 0.09),
        accent: hslToHex(h, Math.min(sat + 0.2, 0.85), 0.62),
    };
}

// Rough, monospace-agnostic word-wrap by character count -- good enough for
// a generated share image, not typeset-perfect.
function wrapText(text, maxCharsPerLine) {
    const words = text.trim().split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (candidate.length > maxCharsPerLine && line) {
            lines.push(line);
            line = w;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}

export async function renderShareImage({ text, title, author, coverUrl }) {
    const hasCover = !!coverUrl;
    const textAreaWidth = hasCover ? WIDTH - COVER_WIDTH - MARGIN - MARGIN : WIDTH - MARGIN * 2;

    const fontSize = text.length > 280 ? (hasCover ? 28 : 34) : text.length > 140 ? (hasCover ? 34 : 42) : hasCover ? 42 : 52;
    const maxChars = Math.floor(textAreaWidth / (fontSize * 0.56));
    const lines = wrapText(text, maxChars).slice(0, 16); // hard cap so it never overflows the canvas
    const lineHeight = fontSize * 1.35;
    const textBlockHeight = lines.length * lineHeight;
    const textStartY = HEIGHT / 2 - textBlockHeight / 2 + fontSize;

    const tspans = lines
        .map((line, i) => `<tspan x="${MARGIN}" y="${textStartY + i * lineHeight}">${escapeXml(line)}</tspan>`)
        .join('');

    const footerY = HEIGHT - 110;
    const watermarkX = hasCover ? MARGIN : WIDTH - MARGIN;
    const watermarkAnchor = hasCover ? 'start' : 'end';

    // Fetch + analyze the cover FIRST (if any) so its dominant color can
    // drive the background palette below, rather than always the fixed navy.
    let coverImg = null;
    let palette = { bgTop: DEFAULT_BG_TOP, bgBottom: DEFAULT_BG_BOTTOM, accent: DEFAULT_ACCENT };
    if (hasCover) {
        try {
            const res = await fetch(coverUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const coverBuf = Buffer.from(await res.arrayBuffer());
                const coverSharp = sharp(coverBuf);
                const hue = await extractCoverHue(coverSharp);
                if (hue) palette = paletteFromHue(hue);
                coverImg = await coverSharp
                    .resize(COVER_WIDTH, HEIGHT, { fit: 'cover' })
                    .composite([]) // normalize format
                    .png()
                    .toBuffer();
            }
        } catch {
            // Cover fetch/analysis failed -- fall back to the default palette
            // and share the image without a cover rather than failing entirely.
        }
    }

    const baseSvg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${palette.bgTop}"/>
          <stop offset="100%" stop-color="${palette.bgBottom}"/>
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <rect x="${MARGIN}" y="60" width="72" height="6" rx="3" fill="${palette.accent}"/>
      <text font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="#eef2f7">${tspans}</text>
      <text x="${MARGIN}" y="${footerY}" font-family="-apple-system, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${escapeXml(title || '')}</text>
      <text x="${MARGIN}" y="${footerY + 38}" font-family="-apple-system, Arial, sans-serif" font-size="24" fill="#9fb0c3">${escapeXml(author || '')}</text>
      <text x="${watermarkX}" y="${HEIGHT - 30}" text-anchor="${watermarkAnchor}" font-family="-apple-system, Arial, sans-serif" font-size="20" fill="#4a5a70">highlights.sdz.nu</text>
    </svg>`;

    const layers = [{ input: Buffer.from(baseSvg) }];

    if (coverImg) {
        layers.push({ input: coverImg, left: WIDTH - COVER_WIDTH, top: 0 });

        // Fade the cover's left edge into the (now cover-tinted) background
        // so it reads as one designed composition, not a photo pasted on
        // top of a hard rectangle.
        const fadeSvg = `
        <svg width="${FADE_WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="${palette.bgTop}" stop-opacity="1"/>
              <stop offset="100%" stop-color="${palette.bgTop}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <rect width="${FADE_WIDTH}" height="${HEIGHT}" fill="url(#fade)"/>
        </svg>`;
        layers.push({ input: Buffer.from(fadeSvg), left: WIDTH - COVER_WIDTH, top: 0 });
    }

    return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: palette.bgTop } })
        .composite(layers)
        .png()
        .toBuffer();
}

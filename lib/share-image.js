import sharp from 'sharp';

const WIDTH = 1080;
const HEIGHT = 1350;
const COVER_WIDTH = 420;
const MARGIN = 60;
const FADE_WIDTH = 140;

function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
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
    // With a cover, text is confined to a left column so it never runs
    // under the (large, right-side) cover image -- matches Readwise's own
    // "Pretty" share layout, just kept in this app's dark theme rather
    // than switching to a light card.
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

    const baseSvg = `
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1b2430"/>
          <stop offset="100%" stop-color="#141b25"/>
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
      <rect x="${MARGIN}" y="60" width="72" height="6" rx="3" fill="#e0c419"/>
      <text font-family="Georgia, 'Times New Roman', serif" font-size="${fontSize}" fill="#eef2f7">${tspans}</text>
      <text x="${MARGIN}" y="${footerY}" font-family="-apple-system, Arial, sans-serif" font-size="30" font-weight="700" fill="#ffffff">${escapeXml(title || '')}</text>
      <text x="${MARGIN}" y="${footerY + 38}" font-family="-apple-system, Arial, sans-serif" font-size="24" fill="#9fb0c3">${escapeXml(author || '')}</text>
      <text x="${watermarkX}" y="${HEIGHT - 30}" text-anchor="${watermarkAnchor}" font-family="-apple-system, Arial, sans-serif" font-size="20" fill="#4a5a70">highlights.sdz.nu</text>
    </svg>`;

    const layers = [{ input: Buffer.from(baseSvg) }];

    if (hasCover) {
        try {
            const res = await fetch(coverUrl, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const coverBuf = Buffer.from(await res.arrayBuffer());
                const coverImg = await sharp(coverBuf)
                    .resize(COVER_WIDTH, HEIGHT, { fit: 'cover' })
                    .composite([]) // normalize format
                    .png()
                    .toBuffer();
                layers.push({ input: coverImg, left: WIDTH - COVER_WIDTH, top: 0 });

                // Fade the cover's left edge into the background so it
                // reads as one designed composition rather than a photo
                // pasted on top of a hard rectangle.
                const fadeSvg = `
                <svg width="${FADE_WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
                  <defs>
                    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stop-color="#1b2430" stop-opacity="1"/>
                      <stop offset="100%" stop-color="#1b2430" stop-opacity="0"/>
                    </linearGradient>
                  </defs>
                  <rect width="${FADE_WIDTH}" height="${HEIGHT}" fill="url(#fade)"/>
                </svg>`;
                layers.push({ input: Buffer.from(fadeSvg), left: WIDTH - COVER_WIDTH, top: 0 });
            }
        } catch {
            // Cover fetch failed/timed out -- share the image without it rather than failing entirely.
        }
    }

    return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#1b2430' } })
        .composite(layers)
        .png()
        .toBuffer();
}

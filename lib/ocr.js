import { spawn } from 'child_process';
import sharp from 'sharp';

// shortcut: English + Dutch only (the two traineddata packages in the Dockerfile); add a
// tesseract-ocr-data-<lang> package and extend this when another language is needed.
const LANGS = 'eng+nld';
const TIMEOUT_MS = 60_000;
const MAX_PIXELS = 120_000_000; // above any phone photo, below a decompression bomb
const MAX_CONCURRENT = 2;
let running = 0;

// Tesseract TSV: level page block par line word left top width height conf text.
// Level 5 rows are words. Coordinates become fractions of the image so the
// browser can overlay them on the photo at any display size.
export function parseTsv(tsv, width, height) {
    const words = [];
    for (const row of tsv.split('\n').slice(1)) {
        const c = row.split('\t');
        if (c[0] !== '5' || c.length < 12) continue;
        const text = c.slice(11).join('\t').trim();
        if (!text) continue;
        const [left, top, w, h] = c.slice(6, 10).map(Number);
        words.push({
            t: text,
            x: left / width,
            y: top / height,
            w: w / width,
            h: h / height,
            line: `${c[2]}.${c[3]}.${c[4]}`,
            par: `${c[2]}.${c[3]}`,
        });
    }
    // A page edge or speck reads as "|"-like strokes far taller or shorter than the text; a lone
    // "|" at text height is the word "I" in most book fonts.
    const hs = words.map((w) => w.h).sort((a, b) => a - b);
    const median = hs[hs.length >> 1];
    return words
        .filter((w) => !(/^[|!Il1[\]]+$/.test(w.t) && (w.h > 2 * median || w.h < 0.5 * median)))
        .map((w) => (w.t === '|' ? { ...w, t: 'I' } : w));
}

function runTesseract(png) {
    return new Promise((resolve, reject) => {
        const proc = spawn('tesseract', ['stdin', 'stdout', '-l', LANGS, 'tsv'], { timeout: TIMEOUT_MS });
        proc.stdout.setEncoding('utf8'); // decode across chunk boundaries (é split over two chunks)
        proc.stderr.setEncoding('utf8');
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => (out += d));
        proc.stderr.on('data', (d) => (err += d));
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tesseract exited ${code}: ${err.slice(0, 200)}`))));
        proc.stdin.on('error', () => {}); // tesseract may exit before reading all input; 'close' reports it
        proc.stdin.end(png);
    });
}

// rotate() applies the EXIF orientation, the same way the browser shows the
// photo, so the word boxes line up with what the user sees.
export async function ocrImage(buffer) {
    if (running >= MAX_CONCURRENT) throw new Error('busy');
    running++;
    try {
        return await ocr(buffer);
    } finally {
        running--;
    }
}

// Removes shadows and uneven lighting: estimates the paper brightness per small block (its
// brightest pixel, since text is darker than paper), smooths that, and divides it out. Unlike one
// global threshold this also handles a hard-edged shadow from a hand or phone across the page.
// Measured on a real photo with such a shadow: 122 -> 141 of 143 words recognised.
export async function flattenLighting(grey, width, height) {
    const block = Math.max(4, Math.round(Math.max(width, height) / 150));
    const bw = Math.ceil(width / block);
    const bh = Math.ceil(height / block);
    const paper = Buffer.alloc(bw * bh);
    for (let y = 0; y < height; y++) {
        const row = ((y / block) | 0) * bw;
        for (let x = 0; x < width; x++) {
            const v = grey[y * width + x];
            const i = row + ((x / block) | 0);
            if (v > paper[i]) paper[i] = v;
        }
    }
    const { data: bg } = await sharp(paper, { raw: { width: bw, height: bh, channels: 1 } })
        .median(3) // drop single blocks that were all ink
        .resize(width, height, { kernel: 'linear' })
        .extractChannel(0) // sharp may hand back 3 channels; the loop below needs exactly one
        .raw()
        .toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(grey.length);
    for (let i = 0; i < grey.length; i++) out[i] = Math.min(255, Math.round((grey[i] * 240) / Math.max(bg[i], 24)));
    return out;
}

async function ocr(buffer) {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
        .rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .extractChannel(0)
        .raw()
        .toBuffer({ resolveWithObject: true });
    const flat = await flattenLighting(data, info.width, info.height);
    const png = await sharp(flat, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
    const tsv = await runTesseract(png);
    return parseTsv(tsv, info.width, info.height);
}

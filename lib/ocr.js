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
    return words;
}

function runTesseract(png) {
    return new Promise((resolve, reject) => {
        const proc = spawn('tesseract', ['stdin', 'stdout', '-l', LANGS, 'tsv'], { timeout: TIMEOUT_MS });
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

async function ocr(buffer) {
    const { data, info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
        .rotate()
        .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
        .greyscale()
        .normalise()
        .png()
        .toBuffer({ resolveWithObject: true });
    const tsv = await runTesseract(data);
    return parseTsv(tsv, info.width, info.height);
}

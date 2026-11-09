import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTsv } from '../lib/ocr.js';

const HEAD = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

test('keeps only word rows, as fractions of the image size', () => {
    const tsv = [
        HEAD,
        '1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t',
        '4\t1\t1\t1\t1\t0\t100\t50\t400\t20\t-1\t',
        '5\t1\t1\t1\t1\t1\t100\t50\t200\t20\t96.1\tHello',
        '5\t1\t1\t1\t2\t1\t100\t80\t200\t20\t95.0\tworld',
        '5\t1\t1\t1\t2\t2\t320\t80\t10\t20\t10.0\t ',
    ].join('\n');
    assert.deepEqual(parseTsv(tsv, 1000, 500), [
        { t: 'Hello', x: 0.1, y: 0.1, w: 0.2, h: 0.04, line: '1.1.1', par: '1.1' },
        { t: 'world', x: 0.1, y: 0.16, w: 0.2, h: 0.04, line: '1.1.2', par: '1.1' },
    ]);
});

test('empty output gives no words', () => {
    assert.deepEqual(parseTsv(HEAD + '\n', 10, 10), []);
});

test('flattenLighting evens out a hard-edged shadow', async () => {
    const { flattenLighting } = await import('../lib/ocr.js');
    const W = 300, H = 200;
    const img = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const paper = x < W / 2 ? 200 : 60; // right half in deep shadow
            const ink = y % 10 < 2 && x % 7 < 2; // thin dark strokes everywhere
            img[y * W + x] = ink ? Math.round(paper * 0.3) : paper;
        }
    }
    const out = await flattenLighting(img, W, H);
    const at = (x, y) => out[y * W + x];
    const paperLeft = at(40, 5), paperRight = at(260, 5), inkRight = at(259, 1);
    assert.ok(Math.abs(paperLeft - paperRight) < 15, `paper equal in light and shadow: ${paperLeft} vs ${paperRight}`);
    assert.ok(paperRight > 200, `shadowed paper brightened: ${paperRight}`);
    assert.ok(paperRight - inkRight > 120, `ink stays dark in the shadow: ${inkRight}`);
});

test('drops page-edge strokes and reads a lone pipe as I', () => {
    const row = (word, left, h, text) => `5\t1\t1\t1\t1\t${word}\t${left}\t50\t40\t${h}\t90\t${text}`;
    const tsv = [HEAD, row(1, 10, 20, 'Later'), row(2, 60, 20, '|'), row(3, 80, 20, 'will'), row(4, 130, 21, 'try'), row(5, 990, 90, '|'), row(6, 995, 4, 'l')].join('\n');
    assert.deepEqual(parseTsv(tsv, 1000, 500).map((w) => w.t), ['Later', 'I', 'will', 'try']);
});

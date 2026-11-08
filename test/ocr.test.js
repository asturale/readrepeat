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

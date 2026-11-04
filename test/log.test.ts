import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Writable } from 'node:stream';
import { createLogger, sanitizeLogLine } from '../src/log.ts';

describe('sanitizeLogLine', () => {
	test('flattens newlines and control characters so a request cannot forge a line or drive the terminal', () => {
		assert.equal(sanitizeLogLine('model=x\n2026-01-01T00:00:00Z error forged\u001b[31m!'), 'model=x 2026-01-01T00:00:00Z error forged [31m!');
		assert.equal(sanitizeLogLine('tab\tok'), 'tab\tok', 'tabs are kept');
	});
	test('bounds the line length', () => {
		const line = sanitizeLogLine('x'.repeat(5000));
		assert.equal(line.length, 2001);
		assert.ok(line.endsWith('…'));
	});
});

describe('createLogger', () => {
	test('writes one sanitized line per entry at or above the threshold', () => {
		const lines: string[] = [];
		const out = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
		const log = createLogger('info', out);
		log.debug('hidden');
		log.info('shown\nnot a second line');
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^\S+ info  shown not a second line\n$/);
	});
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('the bin points at the CLI and is declared once: JSON keeps the last duplicate key silently', async () => {
	const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
	assert.equal(raw.match(/"bin"\s*:/g)?.length, 1);
	assert.deepEqual((JSON.parse(raw) as { bin: unknown }).bin, { claudia: 'src/cli.ts' });
});

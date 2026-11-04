import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanEnv, freePort, REPO_ROOT, run, startFakeCapi, type FakeCapi } from './harness.ts';

const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const CLAUDE_WRAPPER = path.join(import.meta.dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');

/**
 * Put `claude` on PATH the way an install would, backed by the npm package's
 * Node launcher. The shim leaves a marker so the test can tell it ran, rather
 * than a Claude Code that happens to be installed on the machine.
 */
async function claudeOnPath(workspace: string): Promise<{ bin: string; marker: string }> {
	const bin = path.join(workspace, 'bin');
	const marker = path.join(bin, 'shim-ran');
	await mkdir(bin);
	if (process.platform === 'win32') {
		// A .cmd shim, like npm's: spawn() cannot run these without a shell.
		await writeFile(path.join(bin, 'claude.cmd'), `@echo ran> "${marker}"\r\n@"${process.execPath}" "${CLAUDE_WRAPPER}" %*\r\n`);
	} else {
		const shim = path.join(bin, 'claude');
		await writeFile(shim, `#!/bin/sh\necho ran > "${marker}"\nexec "${process.execPath}" "${CLAUDE_WRAPPER}" "$@"\n`);
		await chmod(shim, 0o755);
	}
	return { bin, marker };
}

describe('claudia claude', () => {
	let capi: FakeCapi;
	let workspace: string;
	let note: string;
	let marker: string;
	let env: NodeJS.ProcessEnv;

	before(async () => {
		capi = await startFakeCapi();
		workspace = await mkdtemp(path.join(os.tmpdir(), 'claudia-e2e-'));
		note = path.join(workspace, 'note.txt');
		await writeFile(note, 'the secret word is mango\n');
		const shim = await claudeOnPath(workspace);
		marker = shim.marker;
		env = cleanEnv({
			PATH: `${shim.bin}${path.delimiter}${process.env.PATH ?? ''}`,
			GITHUB_TOKEN: 'gho_e2e',
			CLAUDIA_CAPI_URL: capi.url,
			CLAUDIA_PORT: String(await freePort()), // nothing listens there, so the launcher must bring its own proxy
			CLAUDE_CONFIG_DIR: path.join(workspace, '.claude'),
		});
	});
	after(async () => {
		await capi.close();
		await rm(workspace, { recursive: true, force: true });
	});

	test('brings up a private proxy and hands the terminal to Claude Code with the model wired through', async () => {
		const { code, stdout, stderr } = await run(process.execPath, [
			CLI, 'claude', '--model', 'gpt-mock', '-p', `Read the file \`${note}\` and tell me the secret word.`, '--output-format', 'json', '--allowedTools', 'Read',
		], { cwd: workspace, env });
		assert.equal(code, 0, stderr);
		assert.ok(existsSync(marker), 'the launcher did not run the claude found on PATH');
		const result = JSON.parse(stdout) as { is_error: boolean; result: string };
		assert.equal(result.is_error, false, stdout);
		assert.match(result.result, /mango/);
		const turns = capi.requests.filter(request => request.body.model === 'gpt-mock');
		assert.ok(turns.length >= 2, `expected a tool round, saw ${turns.length} request(s)`);
		assert.deepEqual([...new Set(turns.map(request => request.path))], ['/responses']);
	});

	test('refuses a model the catalog does not have before Claude Code starts', async () => {
		const requestsBefore = capi.requests.length;
		const { code, stderr } = await run(process.execPath, [CLI, 'claude', '--model', 'gpt-7', '-p', 'hi'], { cwd: workspace, env });
		assert.equal(code, 1);
		assert.match(stderr, /not in the Copilot catalog[\s\S]*gpt-mock/);
		assert.deepEqual(capi.requests.slice(requestsBefore).map(request => request.path), ['/models']);
	});
});

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanEnv, freePort, REPO_ROOT, run, startFakeCapi, type FakeCapi } from './harness.ts';

const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');
const LAUNCHERS = {
	claude: path.join(import.meta.dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs'),
	codex: path.join(import.meta.dirname, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
};

/**
 * Put a client on PATH the way an install would, backed by its npm package's
 * Node launcher. The shim leaves a marker so the test can tell it ran, rather
 * than a copy that happens to be installed on the machine.
 */
async function onPath(workspace: string, client: keyof typeof LAUNCHERS): Promise<{ bin: string; marker: string }> {
	const bin = path.join(workspace, 'bin');
	const marker = path.join(bin, `${client}-shim-ran`);
	await mkdir(bin);
	if (process.platform === 'win32') {
		// A .cmd shim, like npm's: spawn() cannot run these without a shell.
		await writeFile(path.join(bin, `${client}.cmd`), `@echo ran> "${marker}"\r\n@"${process.execPath}" "${LAUNCHERS[client]}" %*\r\n`);
	} else {
		const shim = path.join(bin, client);
		await writeFile(shim, `#!/bin/sh\necho ran > "${marker}"\nexec "${process.execPath}" "${LAUNCHERS[client]}" "$@"\n`);
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
		const shim = await onPath(workspace, 'claude');
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

describe('claudia codex', () => {
	let capi: FakeCapi;
	let workspace: string;
	let marker: string;
	let env: NodeJS.ProcessEnv;

	before(async () => {
		capi = await startFakeCapi();
		workspace = await mkdtemp(path.join(os.tmpdir(), 'claudia-e2e-'));
		const codexHome = path.join(workspace, '.codex');
		await mkdir(codexHome); // Codex refuses a CODEX_HOME that does not exist
		const shim = await onPath(workspace, 'codex');
		marker = shim.marker;
		env = cleanEnv({
			PATH: `${shim.bin}${path.delimiter}${process.env.PATH ?? ''}`,
			GITHUB_TOKEN: 'gho_e2e',
			CLAUDIA_CAPI_URL: capi.url,
			CLAUDIA_PORT: String(await freePort()),
			CODEX_HOME: codexHome,
		});
	});
	after(async () => {
		await capi.close();
		await rm(workspace, { recursive: true, force: true });
	});

	test('configures the provider on the command line and runs a turn through /responses', async () => {
		const lastMessage = path.join(workspace, 'last-message.txt');
		const { code, stderr } = await run(process.execPath, [
			CLI, 'codex', 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-m', 'gpt-mock', '--output-last-message', lastMessage, 'Reply with exactly: PONG',
		], { cwd: workspace, env });
		assert.equal(code, 0, stderr);
		assert.ok(existsSync(marker), 'the launcher did not run the codex found on PATH');
		assert.match(await readFile(lastMessage, 'utf8'), /PONG/);
		const turns = capi.requests.filter(request => request.body.model === 'gpt-mock');
		assert.ok(turns.length >= 1, 'Codex never reached the fake CAPI');
		assert.deepEqual([...new Set(turns.map(request => request.path))], ['/responses']);
	});

	test('refuses a model that does not answer on the Responses API before Codex starts', async () => {
		const requestsBefore = capi.requests.length;
		const { code, stderr } = await run(process.execPath, [CLI, 'codex', 'exec', '-m', 'claude-mock', 'hi'], { cwd: workspace, env });
		assert.equal(code, 1);
		assert.match(stderr, /does not answer on the Responses API[\s\S]*gpt-mock/);
		assert.deepEqual(capi.requests.slice(requestsBefore).map(request => request.path), ['/models']);
	});
});

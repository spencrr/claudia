import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanEnv, run, startClaudia, startFakeCapi, type Claudia, type FakeCapi } from './harness.ts';

const CODEX = path.join(import.meta.dirname, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

describe('Codex CLI through claudia', () => {
	let capi: FakeCapi;
	let claudia: Claudia;
	let workspace: string;
	let codexHome: string;

	before(async () => {
		capi = await startFakeCapi();
		claudia = await startClaudia(capi.url);
		workspace = await mkdtemp(path.join(os.tmpdir(), 'claudia-e2e-'));
		codexHome = path.join(workspace, '.codex'); // Codex refuses a CODEX_HOME that does not exist
		await mkdir(codexHome);
	});
	after(async () => {
		claudia.close();
		await capi.close();
		await rm(workspace, { recursive: true, force: true });
	});

	test('completes a turn on /responses with the provider config from the README', async () => {
		const lastMessage = path.join(workspace, 'last-message.txt');
		const config = {
			'model_provider': '"claudia"',
			'model_providers.claudia.name': '"claudia"',
			'model_providers.claudia.base_url': `"${claudia.url}/v1"`,
			'model_providers.claudia.wire_api': '"responses"',
			'model_providers.claudia.env_key': '"OPENAI_API_KEY"',
			'model_providers.claudia.requires_openai_auth': 'false',
			'model_providers.claudia.supports_websockets': 'false',
			'model': '"gpt-mock"',
			'analytics.enabled': 'false',
		};
		const { code, stderr } = await run(process.execPath, [
			CODEX, 'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', lastMessage,
			...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
			'Reply with exactly: PONG',
		], {
			cwd: workspace,
			env: cleanEnv({ OPENAI_API_KEY: 'unused', CODEX_HOME: codexHome }),
		});
		assert.equal(code, 0, stderr);
		assert.match(await readFile(lastMessage, 'utf8'), /PONG/);

		const turns = capi.requests.filter(request => request.body.model === 'gpt-mock');
		assert.ok(turns.length >= 1, 'Codex never reached the fake CAPI');
		assert.deepEqual([...new Set(turns.map(request => request.path))], ['/responses']);
		assert.equal(turns[0]!.body.stream, true);
	});
});

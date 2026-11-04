import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { cleanEnv, run, startClaudia, startFakeCapi, type Claudia, type FakeCapi } from './harness.ts';

// The package's documented launcher for installs that skip postinstall (`npm ci --ignore-scripts`).
const CLAUDE = path.join(import.meta.dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');

describe('Claude Code through claudia', () => {
	let capi: FakeCapi;
	let claudia: Claudia;
	let workspace: string;
	let note: string;

	before(async () => {
		capi = await startFakeCapi();
		claudia = await startClaudia(capi.url);
		workspace = await mkdtemp(path.join(os.tmpdir(), 'claudia-e2e-'));
		note = path.join(workspace, 'note.txt');
		await writeFile(note, 'the secret word is mango\n');
	});
	after(async () => {
		claudia.close();
		await capi.close();
		await rm(workspace, { recursive: true, force: true });
	});

	const backends = [
		{ model: 'claude-mock', upstreamPath: '/v1/messages', resultShape: '"tool_result"' },
		{ model: 'gpt-mock', upstreamPath: '/responses', resultShape: '"function_call_output"' },
	];
	for (const { model, upstreamPath, resultShape } of backends) {
		test(`completes a Read tool round with ${model} via ${upstreamPath}`, async () => {
			const firstRequest = capi.requests.length;
			const { code, stdout, stderr } = await run(process.execPath, [
				CLAUDE, '-p', `Read the file \`${note}\` and tell me the secret word.`,
				'--model', model, '--output-format', 'json', '--allowedTools', 'Read',
			], {
				cwd: workspace,
				env: cleanEnv({
					ANTHROPIC_BASE_URL: claudia.url,
					ANTHROPIC_AUTH_TOKEN: 'unused',
					CLAUDE_CONFIG_DIR: path.join(workspace, '.claude'),
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
					DISABLE_AUTOUPDATER: '1',
				}),
			});
			assert.equal(code, 0, stderr);
			const result = JSON.parse(stdout) as { is_error: boolean; result: string };
			assert.equal(result.is_error, false, stdout);
			assert.match(result.result, /mango/, 'the file content did not make the round trip');

			const turns = capi.requests.slice(firstRequest).filter(request => request.body.model === model);
			assert.ok(turns.length >= 2, `expected a tool round, saw ${turns.length} request(s)`);
			assert.deepEqual([...new Set(turns.map(request => request.path))], [upstreamPath]);
			assert.ok(JSON.stringify(turns.at(-1)!.body).includes(resultShape), `last request lacks ${resultShape}`);
		});
	}
});

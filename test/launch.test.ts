import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { claudeEnv, ensureProxy, fetchCatalog, peekModel, quoteForCmd, runClient, type Proxy } from '../src/launch.ts';
import type { OpenAIModel } from '../src/routes.ts';

const model = (id: string, extra: Partial<OpenAIModel> = {}): OpenAIModel => ({ id, object: 'model', created: 0, owned_by: 'x', supported_endpoints: [], ...extra });
const catalog = [model('claude-sonnet-5-5'), model('claude-haiku-4.5'), model('gpt-6-astra', { context_window: 1_050_000 }), model('gemini-4-argon')];
const proxy: Proxy = { url: 'http://127.0.0.1:1', apiKey: undefined, close() { } };

describe('peekModel', () => {
	test('reads the client flag in its usual spellings and leaves the arguments alone', () => {
		assert.equal(peekModel(['--model', 'gpt-6-astra', '--continue']), 'gpt-6-astra');
		assert.equal(peekModel(['-p', 'hi', '--model=gemini-4-argon']), 'gemini-4-argon');
		assert.equal(peekModel(['-m', 'grok-4.7']), 'grok-4.7');
		assert.equal(peekModel(['-p', 'hi']), undefined);
		assert.equal(peekModel(['--model']), undefined);
	});
});

describe('claudeEnv', () => {
	test('points Claude Code at the proxy and fills in the README defaults', () => {
		const env = claudeEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real' }, proxy, catalog, 'gpt-6-astra');
		assert.equal(env.PATH, '/bin');
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, proxy.url);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'unused');
		assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
		assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-haiku-4.5');
		assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1050000');
	});

	test('the user\'s own settings win, except the two that define the proxy', () => {
		const base = {
			ANTHROPIC_BASE_URL: 'http://elsewhere', ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_MODEL: 'gemini-4-argon',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-5-5', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '42',
		};
		const env = claudeEnv(base, { ...proxy, apiKey: 'k' }, catalog, undefined);
		assert.equal(env.ANTHROPIC_BASE_URL, proxy.url);
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k');
		assert.equal(env.ANTHROPIC_MODEL, 'gemini-4-argon');
		assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-sonnet-5-5');
		assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '0');
		assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '42');
	});

	test('Claude ids and bare aliases need no context override; dated spellings still match', () => {
		assert.equal(claudeEnv({}, proxy, catalog, 'claude-sonnet-5-5').CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
		assert.equal(claudeEnv({}, proxy, catalog, 'claude-sonnet-5.5-20260101').ANTHROPIC_BASE_URL, proxy.url);
		assert.equal(claudeEnv({}, proxy, catalog, 'opus[1m]').ANTHROPIC_BASE_URL, proxy.url);
		assert.equal(claudeEnv({}, proxy, [], undefined).ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined);
	});

	test('an unknown concrete id fails before the client starts, naming the source and listing what exists', () => {
		assert.throws(() => claudeEnv({}, proxy, catalog, 'gpt-7'), /--model gpt-7 is not in the Copilot catalog[\s\S]*gpt-6-astra/);
		assert.throws(() => claudeEnv({ ANTHROPIC_MODEL: 'gpt-7' }, proxy, catalog, undefined), /^Error: ANTHROPIC_MODEL is not in the Copilot catalog/);
	});
});

describe('quoteForCmd', () => {
	test('follows MSVC argv rules: quotes only when needed, doubles backslashes before quotes and at the end', () => {
		assert.equal(quoteForCmd('plain'), 'plain');
		assert.equal(quoteForCmd('C:\\Users\\x\\note.txt'), 'C:\\Users\\x\\note.txt');
		assert.equal(quoteForCmd('two words'), '"two words"');
		assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
		assert.equal(quoteForCmd('back\\"slash'), '"back\\\\\\"slash"');
		assert.equal(quoteForCmd('dir with space\\'), '"dir with space\\\\"');
	});
});

describe('ensureProxy', () => {
	let stranger: http.Server;
	let running: http.Server;
	let strangerPort: number;
	let runningPort: number;

	before(async () => {
		stranger = http.createServer((_, res) => res.end('ok'));
		running = http.createServer((_, res) => { res.setHeader('Server', 'claudia'); res.end('ok'); });
		await Promise.all([stranger, running].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
		strangerPort = (stranger.address() as AddressInfo).port;
		runningPort = (running.address() as AddressInfo).port;
	});
	after(() => { stranger.close(); running.close(); });

	test('reuses a claudia that is already listening on the configured port', async () => {
		const found = await ensureProxy(loadConfig({ GITHUB_TOKEN: 'gho_x', CLAUDIA_PORT: String(runningPort), CLAUDIA_API_KEY: 'k' }));
		assert.equal(found.url, `http://127.0.0.1:${runningPort}`);
		assert.equal(found.apiKey, 'k');
		found.close();
	});

	test('does not adopt a stranger on the port: starts a private server instead and serves the catalog', async () => {
		const capi = http.createServer((_, res) => res.end(JSON.stringify({ data: [{ id: 'claude-x', capabilities: { type: 'chat' } }] })));
		await new Promise<void>(resolve => capi.listen(0, '127.0.0.1', resolve));
		const capiUrl = `http://127.0.0.1:${(capi.address() as AddressInfo).port}`;
		const own = await ensureProxy(loadConfig({ GITHUB_TOKEN: 'gho_x', CLAUDIA_PORT: String(strangerPort), CLAUDIA_CAPI_URL: capiUrl }));
		try {
			assert.notEqual(new URL(own.url).port, String(strangerPort));
			assert.deepEqual((await fetchCatalog(own)).map(m => m.id), ['claude-x']);
			assert.equal((await fetch(`${own.url}/health`)).headers.get('server'), 'claudia');
		} finally {
			own.close();
			capi.close();
		}
	});
});

describe('runClient', () => {
	test('hands back the client\'s exit code and names a missing executable', async () => {
		assert.equal(await runClient(process.execPath, ['-e', 'process.exit(3)'], process.env), 3);
		await assert.rejects(runClient('claudia-no-such-client', [], process.env), /is not on PATH/);
	});
});

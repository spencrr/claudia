import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import type { CapiModel } from '../src/catalog.ts';
import { upstreamHeaders, type ProxyContext } from '../src/proxy.ts';
import { toOpenAIModelList } from '../src/routes.ts';

function context(overrides: Partial<ProxyContext> = {}): ProxyContext {
	return {
		config: loadConfig({}),
		session: { token: 'gho_test', apiUrl: 'https://capi.test', login: undefined, plan: undefined },
		log: silentLogger,
		requestId: 'req-1',
		fetch: globalThis.fetch,
		...overrides,
	};
}

describe('toOpenAIModelList', () => {
	const models: CapiModel[] = [
		{ id: 'gpt-5.6-sol', vendor: 'OpenAI', capabilities: { type: 'chat' }, supported_endpoints: ['/responses', 'ws:/responses'] },
		{ id: 'claude-sonnet-5.5', vendor: 'Anthropic', capabilities: { type: 'chat' }, supported_endpoints: ['/v1/messages', '/chat/completions'] },
		{ id: 'gpt-4.1', vendor: 'Azure OpenAI', capabilities: { type: 'chat' } },
		{ id: 'text-embedding-3-small', vendor: 'Azure OpenAI', capabilities: { type: 'embeddings' } },
		{ id: 'mystery' },
	];

	test('keeps only chat models, sorted, in OpenAI shape', () => {
		const list = toOpenAIModelList(models);
		assert.equal(list.object, 'list');
		assert.deepEqual(list.data.map(m => m.id), ['claude-sonnet-5.5', 'gpt-4.1', 'gpt-5.6-sol']);
		for (const model of list.data) {
			assert.equal(model.object, 'model');
			assert.equal(typeof model.created, 'number');
		}
	});

	test('normalises vendor into owned_by and relays endpoint hints', () => {
		const byId = Object.fromEntries(toOpenAIModelList(models).data.map(m => [m.id, m]));
		assert.equal(byId['gpt-4.1']?.owned_by, 'azure-openai');
		assert.deepEqual(byId['gpt-4.1']?.supported_endpoints, []);
		assert.deepEqual(byId['gpt-5.6-sol']?.supported_endpoints, ['/responses', 'ws:/responses']);
	});
});

describe('upstreamHeaders', () => {
	test('sends the bearer token, client identity and the default integration id', () => {
		const headers = upstreamHeaders(context());
		assert.equal(headers['Authorization'], 'Bearer gho_test');
		assert.match(headers['User-Agent'] ?? '', /^claudia\//);
		assert.equal(headers['X-Request-Id'], 'req-1');
		assert.equal(headers['Copilot-Integration-Id'], 'vscode-chat');
	});

	test('omits Copilot-Integration-Id when disabled', () => {
		const headers = upstreamHeaders(context({ config: loadConfig({ CLAUDIA_INTEGRATION_ID: 'none' }) }));
		assert.equal('Copilot-Integration-Id' in headers, false);
	});
});

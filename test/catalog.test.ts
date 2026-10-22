import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeModelId, pickBackend, type CapiModel } from '../src/catalog.ts';

const catalog: CapiModel[] = [
	{ id: 'claude-sonnet-5.5', vendor: 'Anthropic', supported_endpoints: ['/v1/messages', '/chat/completions'] },
	{ id: 'gpt-5.6-sol', vendor: 'OpenAI', supported_endpoints: ['/responses', 'ws:/responses'] },
	{ id: 'grok-4.7', vendor: 'xAI', supported_endpoints: ['/responses'] },
	{ id: 'gemini-4-argon', vendor: 'Google', supported_endpoints: ['/chat/completions'] },
	{ id: 'gpt-4.1', vendor: 'Azure OpenAI' },
];

describe('normalizeModelId', () => {
	test('equates SDK, dated and endpoint spellings', () => {
		assert.equal(normalizeModelId('claude-sonnet-5-5'), 'claude-sonnet-5.5');
		assert.equal(normalizeModelId('claude-sonnet-5-5-20260101'), 'claude-sonnet-5.5');
		assert.equal(normalizeModelId('Claude-Haiku-4.5'), 'claude-haiku-4.5');
		assert.equal(normalizeModelId('claude-opus-4-6-1m'), 'claude-opus-4.6-1m');
		assert.equal(normalizeModelId('gpt-4.1'), 'gpt-4.1');
		assert.equal(normalizeModelId('gemini-4-argon'), 'gemini-4-argon');
	});
});

describe('pickBackend', () => {
	test('routes by vendor and advertised endpoints', () => {
		assert.equal(pickBackend('claude-sonnet-5-5', catalog), 'messages');
		assert.equal(pickBackend('claude-sonnet-5-5-20260101', catalog), 'messages');
		assert.equal(pickBackend('gpt-5.6-sol', catalog), 'responses');
		assert.equal(pickBackend('grok-4.7', catalog), 'responses');
		assert.equal(pickBackend('gemini-4-argon', catalog), 'chat');
		assert.equal(pickBackend('gpt-4.1', catalog), 'chat');
	});

	test('unknown models fall through to the native endpoint so CAPI reports them', () => {
		assert.equal(pickBackend('claude-fable-5-1', catalog), 'messages');
		assert.equal(pickBackend('totally-made-up', catalog), 'messages');
	});
});

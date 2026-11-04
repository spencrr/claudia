import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectMessage, type MessagesRequest, type SseFrame } from '../src/anthropic.ts';
import { chatToEvents, responsesToEvents, toChatRequest, toResponsesRequest } from '../src/openai.ts';

const request: MessagesRequest = {
	model: 'gpt-x',
	max_tokens: 1000,
	temperature: 0.5,
	system: [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Be kind.' }],
	tools: [
		{ name: 'Read', description: 'Read a file', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
		{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
	],
	tool_choice: { type: 'any', disable_parallel_tool_use: true },
	thinking: { type: 'enabled', budget_tokens: 20000 },
	messages: [
		{ role: 'user', content: 'Open a.txt' },
		{
			role: 'assistant', content: [
				{ type: 'thinking', thinking: 'secret', signature: 'sig' },
				{ type: 'text', text: 'Sure.' },
				{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.txt' } },
			],
		},
		{
			role: 'user', content: [
				{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'hello' }] },
				{ type: 'text', text: 'Now summarise.' },
				{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
			],
		},
	],
};

describe('toChatRequest', () => {
	test('maps system, history, tool results, images and tools to Chat Completions', () => {
		const body = toChatRequest(request) as Record<string, any>;
		assert.deepEqual(body.messages, [
			{ role: 'system', content: 'Be brief.\nBe kind.' },
			{ role: 'user', content: 'Open a.txt' },
			{ role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }] },
			{ role: 'tool', tool_call_id: 'call_1', content: 'hello' },
			{ role: 'user', content: [{ type: 'text', text: 'Now summarise.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
		]);
		assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }]);
		assert.equal(body.tool_choice, 'required');
		assert.equal(body.parallel_tool_calls, false);
		assert.equal(body.max_tokens, 1000);
		assert.equal(body.temperature, 0.5);
		assert.equal(body.stream, true);
		assert.deepEqual(body.stream_options, { include_usage: true });
		assert.equal('reasoning_effort' in body, false);
	});

	test('maps a named tool choice', () => {
		const body = toChatRequest({ ...request, tool_choice: { type: 'tool', name: 'Read' } }) as Record<string, any>;
		assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'Read' } });
	});
});

describe('toResponsesRequest', () => {
	test('maps to Responses input items with instructions and reasoning effort', () => {
		const body = toResponsesRequest(request) as Record<string, any>;
		assert.equal(body.instructions, 'Be brief.\nBe kind.');
		assert.deepEqual(body.input, [
			{ role: 'user', content: 'Open a.txt' },
			{ role: 'assistant', content: [{ type: 'output_text', text: 'Sure.' }] },
			{ type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.txt"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'hello' },
			{ role: 'user', content: [{ type: 'input_text', text: 'Now summarise.' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
		]);
		assert.deepEqual(body.tools, [{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
		assert.equal(body.tool_choice, 'required');
		assert.equal(body.max_output_tokens, 1000);
		assert.deepEqual(body.reasoning, { effort: 'high' });
		assert.equal(body.store, false);
	});

	test('output_config.effort wins over the thinking budget', () => {
		const body = toResponsesRequest({ ...request, output_config: { effort: 'low' } }) as Record<string, any>;
		assert.deepEqual(body.reasoning, { effort: 'low' });
	});

	test("raises Claude Code's max_tokens:1 model probe to the Responses minimum", () => {
		assert.equal((toResponsesRequest({ ...request, max_tokens: 1 }) as Record<string, any>).max_output_tokens, 16);
		assert.equal((toResponsesRequest({ ...request, max_tokens: 4096 }) as Record<string, any>).max_output_tokens, 4096);
	});
});

function frames(...payloads: (object | string)[]): AsyncIterable<SseFrame> {
	return (async function* () {
		for (const payload of payloads) {
			const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
			yield { event: typeof payload === 'object' && 'type' in payload ? String((payload as { type: unknown }).type) : undefined, data };
		}
	})();
}

describe('chatToEvents', () => {
	test('translates text, a streamed tool call and usage into Anthropic events', async () => {
		const events = chatToEvents(frames(
			{ id: 'chatcmpl-1', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] },
			{ id: 'chatcmpl-1', choices: [{ delta: { content: 'lo' } }] },
			{ id: 'chatcmpl-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'Read', arguments: '{"pa' } }] } }] },
			{ id: 'chatcmpl-1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: 'tool_calls' }] },
			{ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } },
			'[DONE]',
		), 'gemini-x');
		const message = await collectMessage(events, 'gemini-x');
		assert.equal(message.id, 'msg_chatcmpl-1');
		assert.equal(message.model, 'gemini-x');
		assert.deepEqual(message.content, [
			{ type: 'text', text: 'Hello' },
			{ type: 'tool_use', id: 'call_9', name: 'Read', input: { path: 'x' } },
		]);
		assert.equal(message.stop_reason, 'tool_use');
		assert.deepEqual(message.usage, { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 4 });
	});

	test('keeps every tool block open until the end so interleaved argument deltas land in the right call', async () => {
		const message = await collectMessage(chatToEvents(frames(
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'Read', arguments: '{"path":' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'Glob', arguments: '{"pattern":' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"*.ts"}' } }] }, finish_reason: 'tool_calls' }] },
			'[DONE]',
		), 'm'), 'm');
		assert.deepEqual(message.content, [
			{ type: 'tool_use', id: 'call_a', name: 'Read', input: { path: 'a.txt' } },
			{ type: 'tool_use', id: 'call_b', name: 'Glob', input: { pattern: '*.ts' } },
		]);
		assert.equal(message.stop_reason, 'tool_use');
	});

	test('text after a tool call opens a new text block instead of closing the tool', async () => {
		const message = await collectMessage(chatToEvents(frames(
			{ choices: [{ delta: { content: 'Let me ' } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'Read', arguments: '{"p":' } }] } }] },
			{ choices: [{ delta: { content: 'look.' } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
			'[DONE]',
		), 'm'), 'm');
		assert.deepEqual(message.content, [
			{ type: 'text', text: 'Let me ' },
			{ type: 'tool_use', id: 'c', name: 'Read', input: { p: 1 } },
			{ type: 'text', text: 'look.' },
		]);
	});

	test('maps length to max_tokens and an error chunk to an error event', async () => {
		const truncated = await collectMessage(chatToEvents(frames({ choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }), 'm'), 'm');
		assert.equal(truncated.stop_reason, 'max_tokens');
		await assert.rejects(collectMessage(chatToEvents(frames({ error: { message: 'quota' } }), 'm'), 'm'), /quota/);
	});
});

describe('responsesToEvents', () => {
	test('translates Responses semantic events into Anthropic events, keyed by output_index', async () => {
		// item_id deliberately differs on every event: CAPI re-encrypts it, only output_index is stable.
		const events = responsesToEvents(frames(
			{ type: 'response.created', response: { id: 'resp_1' } },
			{ type: 'response.output_item.added', output_index: 0, item: { id: 'a', type: 'reasoning' } },
			{ type: 'response.output_item.added', output_index: 1, item: { id: 'b', type: 'message' } },
			{ type: 'response.output_text.delta', output_index: 1, item_id: 'c', delta: 'Par' },
			{ type: 'response.output_text.delta', output_index: 1, item_id: 'd', delta: 'is' },
			{ type: 'response.output_item.done', output_index: 1, item: { id: 'e', type: 'message' } },
			{ type: 'response.output_item.added', output_index: 2, item: { id: 'f', type: 'function_call', call_id: 'call_1', name: 'get_weather' } },
			{ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'g', delta: '{"city":' },
			{ type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'h', delta: '"Paris"}' },
			{ type: 'response.output_item.done', output_index: 2, item: { id: 'i', type: 'function_call' } },
			{ type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 20, output_tokens: 9, input_tokens_details: { cached_tokens: 0 } } } },
		), 'gpt-x');
		const message = await collectMessage(events, 'gpt-x');
		assert.equal(message.id, 'msg_resp_1');
		assert.deepEqual(message.content, [
			{ type: 'text', text: 'Paris' },
			{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
		]);
		assert.equal(message.stop_reason, 'tool_use');
		assert.deepEqual(message.usage, { input_tokens: 20, output_tokens: 9, cache_read_input_tokens: 0 });
	});

	test('maps incomplete/max_output_tokens and failures', async () => {
		const truncated = await collectMessage(responsesToEvents(frames(
			{ type: 'response.created', response: { id: 'r' } },
			{ type: 'response.output_text.delta', output_index: 0, delta: 'x' },
			{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } },
		), 'm'), 'm');
		assert.equal(truncated.stop_reason, 'max_tokens');
		assert.deepEqual(truncated.content, [{ type: 'text', text: 'x' }]);

		await assert.rejects(
			collectMessage(responsesToEvents(frames({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }), 'm'), 'm'),
			/invalid_request_error: bad/,
		);
	});
});

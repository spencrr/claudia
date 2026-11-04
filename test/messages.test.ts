import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { collectMessage, messageToEvents, parseSse, type Message, type StreamEvent } from '../src/anthropic.ts';
import { clearCatalogCache } from '../src/catalog.ts';
import { loadConfig } from '../src/config.ts';
import { createUpstreamResolver } from '../src/github.ts';
import { silentLogger } from '../src/log.ts';
import { createMessagesHandler, countTokens } from '../src/messages.ts';
import { routes as defaultRoutes } from '../src/routes.ts';
import { createServer } from '../src/server.ts';
import type { WebTools } from '../src/webtools.ts';

interface Recorded { path: string; headers: http.IncomingHttpHeaders; body: any }

const sse = (res: http.ServerResponse, events: (object | string)[]) => {
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	for (const event of events) {
		const data = typeof event === 'string' ? event : JSON.stringify(event);
		const name = typeof event === 'object' && 'type' in event ? `event: ${(event as { type: string }).type}\n` : '';
		res.write(`${name}data: ${data}\n\n`);
	}
	res.end();
};

/**
 * Fake CAPI. Every surface answers with a tool call when the latest user turn
 * mentions "weather" and no tool result has been supplied yet, otherwise with
 * text. `/v1/messages` additionally plays along with the local `web_search`
 * tool so the hosted-tool loop can be exercised against the native backend.
 */
function startFakeCapi(): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
	const requests: Recorded[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const body = raw ? JSON.parse(raw) : {};
			requests.push({ path: req.url ?? '', headers: req.headers, body });

			if (req.url === '/models') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					data: [
						{ id: 'claude-sonnet-5.5', vendor: 'Anthropic', capabilities: { type: 'chat' }, supported_endpoints: ['/v1/messages', '/chat/completions'] },
						{ id: 'gpt-5.6-sol', vendor: 'OpenAI', capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] },
						{ id: 'gemini-4-argon', vendor: 'Google', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] },
					],
				}));
				return;
			}

			const text = JSON.stringify(body.messages ?? body.input ?? '');
			const wantsTool = /weather/i.test(text) && !/tool_result|function_call_output|"role":"tool"/.test(text);
			const wantsSearch = /Perform a web search/.test(text) && !/tool_result/.test(text);

			switch (req.url) {
				case '/chat/completions':
					sse(res, wantsTool
						? [{ id: 'c1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_w', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] }, finish_reason: 'tool_calls' }] }, { id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }, '[DONE]']
						: [{ id: 'c1', choices: [{ delta: { content: 'chat says hi' }, finish_reason: 'stop' }] }, { id: 'c1', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }, '[DONE]']);
					return;
				case '/responses':
					sse(res, wantsTool
						? [
							{ type: 'response.created', response: { id: 'r1' } },
							{ type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call_w', name: 'get_weather' } },
							{ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'other', delta: '{"city":"Paris"}' },
							{ type: 'response.output_item.done', output_index: 0, item: { id: 'fc1', type: 'function_call' } },
							{ type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 8, output_tokens: 4 } } },
						]
						: [
							{ type: 'response.created', response: { id: 'r1' } },
							{ type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'responses says hi' },
							{ type: 'response.output_item.done', output_index: 0, item: { id: 'm1', type: 'message' } },
							{ type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 8, output_tokens: 4 } } },
						]);
					return;
				case '/v1/messages': {
					const message: Message = {
						id: 'msg_native', type: 'message', role: 'assistant', model: body.model,
						content: wantsSearch
							? [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id: 'toolu_s', name: 'web_search', input: { query: 'node lts' } }]
							: [{ type: 'text', text: 'native says hi' }],
						stop_reason: wantsSearch ? 'tool_use' : 'end_turn', stop_sequence: null,
						usage: { input_tokens: 2, output_tokens: 1 },
					};
					if (body.stream) {
						sse(res, messageToEvents(message));
					} else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(message));
					}
					return;
				}
				case '/v1/messages/count_tokens':
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ input_tokens: 42 }));
					return;
				default:
					res.writeHead(404);
					res.end();
			}
		});
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
		const { port } = server.address() as AddressInfo;
		resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(done => server.close(() => done())) });
	}));
}

const fakeWebTools: WebTools & { calls: unknown[] } = {
	calls: [],
	async search(query, options) {
		this.calls.push({ query, options });
		return [{ title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Release schedule', pageAge: null }];
	},
	async fetchPage(url) {
		this.calls.push({ url });
		return { title: 'Example', text: 'Example Domain body' };
	},
};

async function readEvents(response: Response): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const frame of parseSse(response.body!)) {
		events.push(JSON.parse(frame.data) as StreamEvent);
	}
	return events;
}

describe('/v1/messages across backends', () => {
	let capi: Awaited<ReturnType<typeof startFakeCapi>>;
	let proxy: { url: string; close: () => Promise<void> };

	before(async () => {
		clearCatalogCache();
		capi = await startFakeCapi();
		const config = loadConfig({ GITHUB_TOKEN: 'gho_test', CLAUDIA_CAPI_URL: capi.url });
		const routes = defaultRoutes.map(route => route.path === '/messages' ? { ...route, handler: createMessagesHandler({ webTools: fakeWebTools }) } : route);
		const server = createServer({ config, upstream: createUpstreamResolver(config, silentLogger), log: silentLogger, routes });
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
		const { port } = server.address() as AddressInfo;
		proxy = { url: `http://127.0.0.1:${port}`, close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }) };
	});
	after(async () => {
		await proxy.close();
		await capi.close();
		clearCatalogCache();
	});

	const post = (path: string, body: object) => fetch(`${proxy.url}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'x-2026' },
		body: JSON.stringify(body),
	});

	test('Claude models pass through untouched', async () => {
		const response = await post('/v1/messages', { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
		assert.equal(response.status, 200);
		assert.equal(((await response.json()) as Message).content[0]?.type, 'text');
		const upstream = capi.requests.at(-1)!;
		assert.equal(upstream.path, '/v1/messages');
		assert.equal(upstream.headers['anthropic-beta'], 'x-2026');
		assert.equal(upstream.body.model, 'claude-sonnet-5-5');
	});

	test('Responses-only models are translated both ways, streaming', async () => {
		const response = await post('/v1/messages', {
			model: 'gpt-5.6-sol', max_tokens: 10, stream: true, system: 'sys',
			tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
			messages: [{ role: 'user', content: 'weather in Paris?' }],
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'text/event-stream');
		const message = await collectMessage((async function* () { yield* await readEvents(response); })(), 'gpt-5.6-sol');
		assert.deepEqual(message.content, [{ type: 'tool_use', id: 'call_w', name: 'get_weather', input: { city: 'Paris' } }]);
		assert.equal(message.stop_reason, 'tool_use');
		assert.equal(message.model, 'gpt-5.6-sol');

		const upstream = capi.requests.at(-1)!;
		assert.equal(upstream.path, '/responses');
		assert.equal(upstream.body.instructions, 'sys');
		assert.equal(upstream.body.tools[0].name, 'get_weather');
		assert.equal(upstream.headers['anthropic-beta'], undefined, 'Anthropic headers stay off OpenAI surfaces');
	});

	test('Chat-only models are translated, non-streaming', async () => {
		const response = await post('/v1/messages', { model: 'gemini-4-argon', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
		assert.equal(response.status, 200);
		const message = await response.json() as Message;
		assert.deepEqual(message.content, [{ type: 'text', text: 'chat says hi' }]);
		assert.equal(message.stop_reason, 'end_turn');
		assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0 });
		assert.equal(capi.requests.at(-1)?.path, '/chat/completions');
	});

	test('hosted web_search runs locally and is rendered in Anthropic block shapes (native backend)', async () => {
		fakeWebTools.calls.length = 0;
		const response = await post('/v1/messages', {
			model: 'claude-sonnet-5-5', max_tokens: 10, stream: true,
			tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
			messages: [{ role: 'user', content: 'Perform a web search for the query: node lts' }],
		});
		assert.equal(response.status, 200);
		const message = await collectMessage((async function* () { yield* await readEvents(response); })(), 'claude-sonnet-5-5');

		assert.deepEqual(fakeWebTools.calls, [{ query: 'node lts', options: { allowedDomains: undefined, blockedDomains: undefined } }]);
		assert.deepEqual(message.content, [
			{ type: 'server_tool_use', id: 'toolu_s', name: 'web_search', input: { query: 'node lts' } },
			{ type: 'web_search_tool_result', tool_use_id: 'toolu_s', content: [{ type: 'web_search_result', title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', encrypted_content: '', page_age: null }] },
			{ type: 'text', text: 'native says hi' },
		]);
		assert.equal(message.stop_reason, 'end_turn');
		assert.deepEqual(message.usage, { input_tokens: 4, output_tokens: 2, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } });

		const [first, second] = capi.requests.slice(-2);
		assert.equal(first!.body.tools[0].name, 'web_search');
		assert.equal(first!.body.tools[0].input_schema.required[0], 'query', 'hosted tool replaced by a JSON-schema tool');
		assert.equal(second!.body.messages.at(-1).content[0].type, 'tool_result', 'search result fed back to the model');
	});

	test('count_tokens passes through for Claude and estimates for other vendors', async () => {
		const native = await post('/v1/messages/count_tokens', { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] });
		assert.deepEqual(await native.json(), { input_tokens: 42 });
		const estimated = await post('/v1/messages/count_tokens', { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] });
		const { input_tokens } = await estimated.json() as { input_tokens: number };
		assert.ok(input_tokens > 0 && input_tokens < 100);
	});

	test('rejects malformed requests with an Anthropic error envelope', async () => {
		const response = await post('/v1/messages', { max_tokens: 1 });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { type: 'error', error: { type: 'invalid_request_error', message: 'Request must include "model" and "messages"' } });
	});
});

describe('countTokens handler', () => {
	test('is exported for custom route tables', () => {
		assert.equal(typeof countTokens, 'function');
	});
});

import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadConfig } from '../src/config.ts';
import { createUpstreamResolver, type UpstreamResolver } from '../src/github.ts';
import { silentLogger } from '../src/log.ts';
import { createServer, isAuthorized, normalizePath } from '../src/server.ts';

interface RecordedRequest {
	method: string;
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** Stand-in for CAPI: records what it receives and answers per path/model. */
function startFakeCapi(): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });

			if (req.url === '/models') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					data: [
						{ id: 'gpt-4.1', vendor: 'Azure OpenAI', capabilities: { type: 'chat' } },
						{ id: 'text-embedding-3-small', vendor: 'Azure OpenAI', capabilities: { type: 'embeddings' } },
					],
				}));
				return;
			}

			const parsed = body ? JSON.parse(body) as { model?: string; stream?: boolean } : {};
			switch (parsed.model) {
				case 'unauthorized':
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'bad token' } }));
					return;
				case 'gzip-me':
					res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
					res.end(gzipSync(JSON.stringify({ compressed: true })));
					return;
			}
			if (parsed.stream) {
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
				res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
				res.end('data: [DONE]\n\n');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ echo: { path: req.url, body } }));
		});
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () => new Promise(done => server.close(() => done())),
			});
		});
	});
}

function startProxy(env: NodeJS.ProcessEnv): Promise<{ url: string; invalidations: () => number; close: () => Promise<void> }> {
	const config = loadConfig({ GITHUB_TOKEN: 'gho_test', ...env });
	let invalidations = 0;
	const inner = createUpstreamResolver(config, silentLogger);
	const upstream: UpstreamResolver = {
		get: () => inner.get(),
		invalidate: () => { invalidations++; inner.invalidate(); },
	};
	const server = createServer({ config, upstream, log: silentLogger });
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				invalidations: () => invalidations,
				close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
			});
		});
	});
}

describe('proxy server', () => {
	let capi: Awaited<ReturnType<typeof startFakeCapi>>;
	let proxy: Awaited<ReturnType<typeof startProxy>>;

	before(async () => {
		capi = await startFakeCapi();
		proxy = await startProxy({ CLAUDIA_CAPI_URL: capi.url });
	});
	after(async () => {
		await proxy.close();
		await capi.close();
	});

	test('health check needs no auth and hits nothing upstream', async () => {
		const before = capi.requests.length;
		const response = await fetch(`${proxy.url}/`);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'ok');
		assert.equal(capi.requests.length, before);
	});

	test('GET /v1/models returns the translated OpenAI list', async () => {
		const response = await fetch(`${proxy.url}/v1/models`);
		assert.equal(response.status, 200);
		const list = await response.json() as { object: string; data: { id: string; object: string }[] };
		assert.equal(list.object, 'list');
		assert.deepEqual(list.data.map(m => m.id), ['gpt-4.1']);
		assert.equal(list.data[0]?.object, 'model');
	});

	test('POST /v1/chat/completions forwards the body verbatim with the Copilot bearer', async () => {
		const body = '{"model":"gpt-4.1","messages":[{"role":"user","content":"hi"}],"temperature":0.2}';
		const response = await fetch(`${proxy.url}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer client-key-ignored', 'X-Stainless-Lang': 'js' },
			body,
		});
		assert.equal(response.status, 200);
		assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
		assert.deepEqual(await response.json(), { echo: { path: '/chat/completions', body } });

		const upstream = capi.requests.at(-1)!;
		assert.equal(upstream.method, 'POST');
		assert.equal(upstream.headers.authorization, 'Bearer gho_test');
		assert.equal(upstream.headers['content-type'], 'application/json');
		assert.match(upstream.headers['user-agent'] ?? '', /^claudia\//);
		assert.equal(upstream.headers['x-stainless-lang'], undefined, 'client telemetry headers are not relayed');
		assert.equal(upstream.headers['copilot-integration-id'], 'vscode-chat');
	});

	test('POST /v1/messages relays Anthropic headers to CAPI /v1/messages', async () => {
		const body = '{"model":"claude-sonnet-5-5","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}';
		const response = await fetch(`${proxy.url}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'interleaved-thinking-2025-05-14,claude-code-20250219',
				'x-api-key': 'sk-ant-should-not-leak',
			},
			body,
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { echo: { path: '/v1/messages', body } });

		const upstream = capi.requests.at(-1)!;
		assert.equal(upstream.headers.authorization, 'Bearer gho_test');
		assert.equal(upstream.headers['anthropic-version'], '2023-06-01');
		assert.equal(upstream.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14,claude-code-20250219');
		assert.equal(upstream.headers['x-api-key'], undefined, 'client credentials are never relayed');
	});

	test('POST /v1/messages/count_tokens maps to the CAPI path', async () => {
		const response = await fetch(`${proxy.url}/v1/messages/count_tokens`, { method: 'POST', body: '{"model":"claude-haiku-5-5","messages":[]}' });
		assert.equal(response.status, 200);
		assert.equal(capi.requests.at(-1)?.path, '/v1/messages/count_tokens');
	});

	test('accepts paths without the /v1 prefix', async () => {
		const response = await fetch(`${proxy.url}/responses`, { method: 'POST', body: '{"model":"gpt-5.6-sol","input":"hi"}' });
		assert.equal(response.status, 200);
		assert.equal(capi.requests.at(-1)?.path, '/responses');
	});

	test('streams SSE bytes through unchanged', async () => {
		const response = await fetch(`${proxy.url}/v1/chat/completions`, {
			method: 'POST',
			body: '{"model":"gpt-4.1","stream":true,"messages":[]}',
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-type'), 'text/event-stream');
		assert.equal(
			await response.text(),
			'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
		);
	});

	test('relays upstream errors verbatim and invalidates the session on 401', async () => {
		const before = proxy.invalidations();
		const response = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', body: '{"model":"unauthorized"}' });
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: { message: 'bad token' } });
		assert.equal(proxy.invalidations(), before + 1);
	});

	test('does not relay content-encoding for bodies fetch already decoded', async () => {
		const response = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', body: '{"model":"gzip-me"}' });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('content-encoding'), null);
		assert.deepEqual(await response.json(), { compressed: true });
	});

	test('unknown routes and wrong methods get OpenAI-style errors', async () => {
		const missing = await fetch(`${proxy.url}/v1/embeddings`, { method: 'POST', body: '{}' });
		assert.equal(missing.status, 404);
		assert.equal(((await missing.json()) as { error: { type: string } }).error.type, 'not_found_error');

		const wrongMethod = await fetch(`${proxy.url}/v1/chat/completions`);
		assert.equal(wrongMethod.status, 405);
	});
});

describe('proxy server with an API key', () => {
	let capi: Awaited<ReturnType<typeof startFakeCapi>>;
	let proxy: Awaited<ReturnType<typeof startProxy>>;

	before(async () => {
		capi = await startFakeCapi();
		proxy = await startProxy({ CLAUDIA_CAPI_URL: capi.url, CLAUDIA_API_KEY: 's3cret' });
	});
	after(async () => {
		await proxy.close();
		await capi.close();
	});

	test('rejects missing or wrong keys before touching upstream', async () => {
		const before = capi.requests.length;
		assert.equal((await fetch(`${proxy.url}/v1/models`)).status, 401);
		assert.equal((await fetch(`${proxy.url}/v1/models`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
		assert.equal(capi.requests.length, before);
	});

	test('accepts the configured key as a bearer token or as x-api-key', async () => {
		assert.equal((await fetch(`${proxy.url}/v1/models`, { headers: { Authorization: 'Bearer s3cret' } })).status, 200);
		assert.equal((await fetch(`${proxy.url}/v1/models`, { headers: { 'x-api-key': 's3cret' } })).status, 200);
		assert.equal((await fetch(`${proxy.url}/v1/models`, { headers: { 'x-api-key': 'wrong' } })).status, 401);
	});
});

describe('proxy server with an unreachable upstream', () => {
	test('answers 502 with an OpenAI error envelope', async () => {
		const closedPort = await new Promise<number>(resolve => {
			const probe = http.createServer();
			probe.listen(0, '127.0.0.1', () => {
				const { port } = probe.address() as AddressInfo;
				probe.close(() => resolve(port));
			});
		});
		const proxy = await startProxy({ CLAUDIA_CAPI_URL: `http://127.0.0.1:${closedPort}` });
		try {
			const response = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', body: '{"model":"gpt-4.1"}' });
			assert.equal(response.status, 502);
			const body = await response.json() as { error: { type: string; message: string } };
			assert.equal(body.error.type, 'api_error');
			assert.match(body.error.message, /Upstream request failed/);
		} finally {
			await proxy.close();
		}
	});
});

describe('normalizePath', () => {
	test('strips /v1, trailing slashes and query strings', () => {
		assert.equal(normalizePath('/v1/chat/completions'), '/chat/completions');
		assert.equal(normalizePath('/chat/completions/'), '/chat/completions');
		assert.equal(normalizePath('/v1/models?limit=5'), '/models');
		assert.equal(normalizePath('/v1'), '/');
		assert.equal(normalizePath('/v1/'), '/');
		assert.equal(normalizePath('/'), '/');
		assert.equal(normalizePath('/v10/models'), '/v10/models');
	});
});

describe('isAuthorized', () => {
	test('is open when no key is configured', () => {
		assert.equal(isAuthorized({}, undefined), true);
		assert.equal(isAuthorized({ authorization: 'Bearer anything' }, undefined), true);
	});
	test('requires an exact match via bearer or x-api-key when a key is configured', () => {
		assert.equal(isAuthorized({ authorization: 'Bearer k' }, 'k'), true);
		assert.equal(isAuthorized({ 'x-api-key': 'k' }, 'k'), true);
		assert.equal(isAuthorized({ authorization: 'Bearer kk' }, 'k'), false);
		assert.equal(isAuthorized({ authorization: 'Basic k' }, 'k'), false);
		assert.equal(isAuthorized({ authorization: 'Bearer wrong', 'x-api-key': 'k' }, 'k'), false, 'a presented bearer is not rescued by x-api-key');
		assert.equal(isAuthorized({}, 'k'), false);
	});
});

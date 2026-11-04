import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWebTools, decodeEntities, htmlToText, isPublicAddress, parseGitHubSearch, withDomainOperators } from '../src/webtools.ts';

interface Recorded { url: string; init: RequestInit | undefined }

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: Recorded[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return respond(url, init);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const mcpResult = (payload: object | string, isError = false) => ({
	jsonrpc: '2.0', id: 1,
	result: { isError, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] },
});

const twoResults = {
	search_result_groups: [{
		search_result_type: 'webResults',
		items: [
			{ title: 'Node.js — Releases', url: 'https://nodejs.org/en/about/previous-releases', snippets: ['Release   schedule ', 'and more'], last_updated_date: '03/11/2026 00:00:00' },
			{ title: '', url: 'https://github.com/nodejs/Release', snippets: ['x'.repeat(2000)] },
			{ title: 'no url' },
		],
	}],
	error_message: '',
	no_results_message: '',
	cached: false,
};

describe('parseGitHubSearch', () => {
	test('unwraps an SSE frame and normalises items', () => {
		const results = parseGitHubSearch(`event: message\ndata: ${JSON.stringify(mcpResult(twoResults))}\n\n`);
		assert.equal(results.length, 2);
		assert.deepEqual(results[0], { title: 'Node.js — Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Release schedule and more', pageAge: '03/11/2026 00:00:00' });
		assert.equal(results[1]?.title, 'https://github.com/nodejs/Release', 'empty title falls back to the URL');
		assert.equal(results[1]?.snippet.length, 1500, 'snippets are truncated');
		assert.equal(results[1]?.pageAge, null);
	});

	test('accepts plain JSON too', () => {
		assert.equal(parseGitHubSearch(JSON.stringify(mcpResult(twoResults))).length, 2);
	});

	test('reports server-side problems as errors and no-results as empty', () => {
		assert.throws(() => parseGitHubSearch(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'rate limited' } })), /rate limited/);
		assert.throws(() => parseGitHubSearch(JSON.stringify(mcpResult('missing required parameter: query', true))), /missing required parameter/);
		assert.throws(() => parseGitHubSearch(JSON.stringify(mcpResult({ error_message: 'backend down' }))), /backend down/);
		assert.throws(() => parseGitHubSearch(JSON.stringify(mcpResult('<html>oops</html>'))), /non-JSON/);
		assert.throws(() => parseGitHubSearch('garbage'), /unreadable/);
		assert.deepEqual(parseGitHubSearch(JSON.stringify(mcpResult({ search_result_groups: [], no_results_message: 'nothing' }))), []);
	});
});

describe('withDomainOperators', () => {
	test('encodes allow/block lists as site: operators', () => {
		assert.equal(withDomainOperators(' q ', {}), 'q');
		assert.equal(withDomainOperators('q', { allowedDomains: ['a.com'] }), 'q site:a.com');
		assert.equal(withDomainOperators('q', { allowedDomains: ['a.com', 'b.org'] }), 'q (site:a.com OR site:b.org)');
		assert.equal(withDomainOperators('q', { blockedDomains: ['x.net', 'y.io'] }), 'q -site:x.net -site:y.io');
	});
});

describe('createWebTools().search', () => {
	test('posts one stateless tools/call to {apiUrl}/mcp with the session bearer and post-filters domains', async () => {
		const { fetch, calls } = fakeFetch(() => new Response(`data: ${JSON.stringify(mcpResult(twoResults))}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }));
		const tools = createWebTools({ apiUrl: 'https://capi.test', token: 'gho_x', fetch });
		const results = await tools.search('node lts', { allowedDomains: ['nodejs.org'] });

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, 'https://capi.test/mcp');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		assert.equal(headers['Authorization'], 'Bearer gho_x');
		assert.equal(headers['X-MCP-Tools'], 'web_search');
		const body = JSON.parse(calls[0]?.init?.body as string) as { method: string; params: { name: string; arguments: { query: string } } };
		assert.equal(body.method, 'tools/call');
		assert.equal(body.params.name, 'web_search');
		assert.equal(body.params.arguments.query, 'node lts site:nodejs.org');
		assert.deepEqual(results.map(r => r.url), ['https://nodejs.org/en/about/previous-releases'], 'github.com result removed by the post-filter');
	});

	test('surfaces HTTP failures', async () => {
		const tools = createWebTools({ apiUrl: 'https://capi.test', token: 't', fetch: fakeFetch(() => new Response('', { status: 503 })).fetch });
		await assert.rejects(tools.search('q', {}), /HTTP 503/);
	});
});

describe('isPublicAddress', () => {
	test('rejects every non-public range, in every spelling the URL parser can produce', () => {
		for (const ip of [
			'127.0.0.1', '127.8.8.8', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
			'::1', '::', '0:0:0:0:0:0:0:1', 'fe80::1', 'fc00::1', 'fd12::1', 'fec0::1', 'ff02::1',
			// IPv4-mapped: dotted and the hex form `new URL` normalizes to
			'::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::FFFF:7F00:1',
			// IPv4-compatible (deprecated), NAT64 and 6to4 embeddings of 127.0.0.1
			'::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1',
			'not-an-ip', '',
		]) {
			assert.equal(isPublicAddress(ip), false, ip);
		}
	});
	test('accepts public addresses', () => {
		for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808']) {
			assert.equal(isPublicAddress(ip), true, ip);
		}
	});
	test('agrees with how new URL() spells bracketed literals', () => {
		for (const literal of ['[::ffff:127.0.0.1]', '[::ffff:169.254.169.254]', '[0:0:0:0:0:ffff:7f00:1]', '[::1]']) {
			const hostname = new URL(`http://${literal}/`).hostname.replace(/^\[|\]$/g, '');
			assert.equal(isPublicAddress(hostname), false, `${literal} → ${hostname}`);
		}
	});
});

describe('createWebTools().fetchPage', () => {
	const resolving = (table: Record<string, string[]>) => async (host: string) => table[host] ?? [];

	test('refuses non-http, credentialed, dotless, localhost and private-resolving targets before any request', async () => {
		const { fetch, calls } = fakeFetch(() => new Response('should not be reached'));
		const tools = createWebTools({ apiUrl: 'x', token: 't', fetch, resolve: resolving({ 'internal.corp.example': ['10.0.0.5'], 'gone.example': [] }) });
		for (const [url, pattern] of [
			['file:///etc/passwd', /only http\(s\)/],
			['http://user:pw@example.com/', /credentials/],
			['http://intranet/', /not a public host/],
			['http://localhost:8080/', /not a public host/],
			['http://foo.localhost/', /not a public host/],
			['http://127.0.0.1:4242/v1/models', /private address/],
			['http://[::1]/', /private address/],
			['http://[::ffff:127.0.0.1]:4242/v1/models', /private address/],
			['http://[::ffff:a9fe:a9fe]/latest/meta-data/', /private address/],
			['http://169.254.169.254/latest/meta-data/', /private address/],
			['http://internal.corp.example/', /private address/],
			['http://gone.example/', /does not resolve/],
		] as const) {
			await assert.rejects(tools.fetchPage(url), pattern, url);
		}
		assert.equal(calls.length, 0);
	});

	test('fetches a public page, converts HTML and bounds the body', async () => {
		const { fetch, calls } = fakeFetch(() => new Response('<html><head><title>T</title></head><body><p>hello</p><p>' + 'x'.repeat(2_000_000) + '</p></body></html>', { headers: { 'Content-Type': 'text/html' } }));
		const tools = createWebTools({ apiUrl: 'x', token: 't', fetch, resolve: resolving({ 'example.com': ['93.184.216.34'] }) });
		const page = await tools.fetchPage('https://example.com/');
		assert.equal(page.title, 'T');
		assert.ok(page.text.startsWith('hello\n'));
		assert.ok(page.text.length <= 100_000);
		assert.equal((calls[0]?.init as RequestInit).redirect, 'manual');
	});

	test('follows redirects hop by hop and refuses one that lands on a private address', async () => {
		const { fetch } = fakeFetch(url => url.startsWith('https://public.example/')
			? new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/' } })
			: new Response('nope'));
		const tools = createWebTools({ apiUrl: 'x', token: 't', fetch, resolve: resolving({ 'public.example': ['93.184.216.34'] }) });
		await assert.rejects(tools.fetchPage('https://public.example/start'), /private address/);
	});

	test('gives up after too many redirects', async () => {
		const { fetch } = fakeFetch(url => new Response(null, { status: 301, headers: { Location: url + 'x' } }));
		const tools = createWebTools({ apiUrl: 'x', token: 't', fetch, resolve: resolving({ 'public.example': ['93.184.216.34'] }) });
		await assert.rejects(tools.fetchPage('https://public.example/'), /too many redirects/);
	});
});

describe('htmlToText', () => {
	test('drops scripts/styles, keeps block structure and the title', () => {
		const page = htmlToText('<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><script>x()</script><h1>Head</h1><p>One<br>two</p><ul><li>a</li><li>b</li></ul></body></html>');
		assert.equal(page.title, 'Hi & bye');
		assert.equal(page.text, 'Head\nOne\ntwo\na\nb');
	});
});

describe('decodeEntities', () => {
	test('handles named, decimal and hex entities', () => {
		assert.equal(decodeEntities('&lt;a&gt; &#65;&#x42; &nbsp;&unknown;'), '<a> AB  &unknown;');
	});
});

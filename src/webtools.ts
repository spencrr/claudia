/**
 * Local implementations of Anthropic's hosted `web_search` / `web_fetch`
 * tools, which CAPI refuses for every model.
 *
 * - Search calls GitHub's own web search — the `web_search` tool of the GitHub
 *   MCP server at `{capi}/mcp`, the same backend Copilot CLI uses — with the
 *   session's Copilot token. One stateless JSON-RPC `tools/call` per search.
 * - Fetch is a plain HTTP GET performed here, guarded against private
 *   addresses because the proxy fetches on the model's behalf.
 */

import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { VERSION } from './proxy.ts';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Free-form recency from the search backend, e.g. `03/11/2026 00:00:00`; `null` when unknown. */
	pageAge: string | null;
}
export interface SearchOptions { allowedDomains?: string[] | undefined; blockedDomains?: string[] | undefined }
export interface FetchedPage { title: string | null; text: string }

export interface WebTools {
	search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]>;
	fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage>;
}

/**
 * One hop of a page fetch, connected to `address` (already vetted) while the
 * request still carries `url`'s hostname for Host/SNI. Returns a `Response`
 * so the body/redirect handling is shared with the test fakes.
 */
export type PinnedRequest = (url: URL, address: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Response>;

export interface WebToolsDeps {
	/** CAPI base URL for the session, e.g. `https://api.githubcopilot.com` — no trailing slash. */
	readonly apiUrl: string;
	/** Copilot (GitHub OAuth) token; the MCP endpoint accepts the same bearer as CAPI. */
	readonly token: string;
	/** Used for the search API call. */
	readonly fetch?: typeof globalThis.fetch;
	/** Hostname → addresses; injectable so the private-address guard is testable offline. */
	readonly resolve?: (hostname: string) => Promise<string[]>;
	/** Page fetch transport; injectable for tests. */
	readonly request?: PinnedRequest;
}

const MAX_SNIPPET_CHARS = 1_500;
const MAX_PAGE_CHARS = 100_000;
const MAX_PAGE_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = `claudia/${VERSION}`;

export function createWebTools(deps: WebToolsDeps): WebTools {
	const fetchFn = deps.fetch ?? globalThis.fetch;
	const resolve = deps.resolve ?? defaultResolve;
	const request = deps.request ?? pinnedRequest;
	return {
		search: (query, options, signal) => githubWebSearch(deps.apiUrl, deps.token, fetchFn, query, options, signal),
		fetchPage: (url, signal) => fetchPublicPage(request, resolve, url, signal),
	};
}

// #region Search (GitHub MCP `web_search`)

interface McpEnvelope {
	readonly error?: { readonly code?: number; readonly message?: string };
	readonly result?: {
		readonly isError?: boolean;
		readonly content?: readonly { readonly type: string; readonly text?: string }[];
	};
}

interface GitHubSearchPayload {
	readonly search_result_groups?: readonly {
		readonly search_result_type?: string;
		readonly items?: readonly { readonly title?: string; readonly url?: string; readonly snippets?: readonly string[]; readonly last_updated_date?: string }[];
	}[];
	readonly error_message?: string;
	readonly no_results_message?: string;
}

async function githubWebSearch(apiUrl: string, token: string, fetchFn: typeof globalThis.fetch, query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]> {
	const response = await fetchFn(`${apiUrl}/mcp`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			'User-Agent': USER_AGENT,
			// Only the search tool is needed; the header keeps the server from loading the rest.
			'X-MCP-Tools': 'web_search',
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search', arguments: { query: withDomainOperators(query, options) } } }),
		...(signal ? { signal } : {}),
	});
	if (!response.ok) {
		throw new Error(`GitHub web search returned HTTP ${response.status}`);
	}
	return filterByDomain(parseGitHubSearch(await response.text()), options);
}

/** `site:` / `-site:` are honoured by the backend; the post-filter in {@link filterByDomain} is the safety net. */
export function withDomainOperators(query: string, { allowedDomains, blockedDomains }: SearchOptions): string {
	const parts = [query.trim()];
	if (allowedDomains?.length) {
		parts.push(allowedDomains.length === 1 ? `site:${allowedDomains[0]}` : `(${allowedDomains.map(d => `site:${d}`).join(' OR ')})`);
	}
	for (const domain of blockedDomains ?? []) {
		parts.push(`-site:${domain}`);
	}
	return parts.join(' ');
}

/**
 * Unwrap the MCP response (an SSE frame or plain JSON, by server choice), then
 * the tool's JSON text payload. Server-reported problems become thrown errors;
 * an explicit "no results" is an empty list.
 */
export function parseGitHubSearch(raw: string): SearchResult[] {
	const json = raw.trimStart().startsWith('{') ? raw : /^data: (.*)$/m.exec(raw)?.[1];
	if (!json) {
		throw new Error('GitHub web search returned an unreadable response');
	}
	const envelope = JSON.parse(json) as McpEnvelope;
	if (envelope.error) {
		throw new Error(`GitHub web search error: ${envelope.error.message ?? JSON.stringify(envelope.error)}`);
	}
	const text = envelope.result?.content?.find(part => part.type === 'text')?.text ?? '';
	if (envelope.result?.isError) {
		throw new Error(`GitHub web search error: ${text || 'unknown error'}`);
	}
	let payload: GitHubSearchPayload;
	try {
		payload = JSON.parse(text) as GitHubSearchPayload;
	} catch {
		throw new Error(`GitHub web search returned non-JSON results: ${text.slice(0, 200)}`);
	}
	if (payload.error_message) {
		throw new Error(`GitHub web search error: ${payload.error_message}`);
	}
	const results: SearchResult[] = [];
	for (const group of payload.search_result_groups ?? []) {
		for (const item of group.items ?? []) {
			if (!item.url) {
				continue;
			}
			results.push({
				title: item.title?.trim() || item.url,
				url: item.url,
				snippet: (item.snippets ?? []).join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS),
				pageAge: item.last_updated_date ?? null,
			});
		}
	}
	return results;
}

function filterByDomain(results: SearchResult[], { allowedDomains, blockedDomains }: SearchOptions): SearchResult[] {
	const host = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
	const matches = (h: string, domain: string) => h === domain.toLowerCase() || h.endsWith(`.${domain.toLowerCase()}`);
	return results.filter(r => {
		const h = host(r.url);
		if (allowedDomains?.length && !allowedDomains.some(d => matches(h, d))) {
			return false;
		}
		return !blockedDomains?.some(d => matches(h, d));
	});
}

// #endregion

// #region Fetch

async function fetchPublicPage(request: PinnedRequest, resolve: (hostname: string) => Promise<string[]>, url: string, signal?: AbortSignal): Promise<FetchedPage> {
	const combined = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
	let target = new URL(url);
	// Follow redirects by hand so every hop is checked: an open redirect to an
	// internal address is the classic way around a hostname allow-check.
	for (let hop = 0; ; hop++) {
		// Connect to the address that was vetted, not to a second lookup's answer
		// (DNS rebinding would otherwise pass the check and connect elsewhere).
		const address = await assertPublicUrl(target, resolve, combined);
		const response = await request(target, address, { 'User-Agent': USER_AGENT, 'Accept': 'text/html, text/plain;q=0.9, */*;q=0.5' }, combined);
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location');
			await response.body?.cancel().catch(() => undefined);
			if (!location || hop >= MAX_REDIRECTS) {
				throw new Error(`fetch failed: ${location ? 'too many redirects' : `HTTP ${response.status} without a Location header`}`);
			}
			target = new URL(location, target);
			continue;
		}
		if (!response.ok) {
			throw new Error(`fetch returned HTTP ${response.status}`);
		}
		const body = await readBounded(response, MAX_PAGE_BYTES);
		const isHtml = (response.headers.get('content-type') ?? '').includes('html') || /^\s*<(!doctype|html)/i.test(body);
		return isHtml ? htmlToText(body) : { title: null, text: body.slice(0, MAX_PAGE_CHARS) };
	}
}

/** Vets `target` and returns the one address to connect to. Every resolved address must be public. */
async function assertPublicUrl(target: URL, resolve: (hostname: string) => Promise<string[]>, signal: AbortSignal): Promise<string> {
	if (!/^https?:$/.test(target.protocol)) {
		throw new Error(`refusing to fetch ${target}: only http(s) URLs are allowed`);
	}
	if (target.username || target.password) {
		throw new Error(`refusing to fetch ${target.hostname}: credentials in URLs are not allowed`);
	}
	const hostname = target.hostname.replace(/^\[|\]$/g, '');
	if (hostname === 'localhost' || hostname.endsWith('.localhost') || (!isIP(hostname) && !hostname.includes('.'))) {
		throw new Error(`refusing to fetch ${target.hostname}: not a public host`);
	}
	const addresses = isIP(hostname) ? [hostname] : await abortable(resolve(hostname), signal);
	if (addresses.length === 0) {
		throw new Error(`refusing to fetch ${target.hostname}: hostname does not resolve`);
	}
	for (const address of addresses) {
		if (!isPublicAddress(address)) {
			throw new Error(`refusing to fetch ${target.hostname}: resolves to a private address`);
		}
	}
	return addresses[0]!;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

async function defaultResolve(hostname: string): Promise<string[]> {
	const records = await lookup(hostname, { all: true });
	return records.map(record => record.address);
}

/** `node:http(s)` request whose socket connects to `address` while Host and TLS SNI still come from `url`. */
const pinnedRequest: PinnedRequest = (url, address, headers, signal) => new Promise<Response>((resolve, reject) => {
	const family = isIP(address) === 6 ? 6 : 4;
	const client = url.protocol === 'https:' ? https : http;
	const req = client.request(url, {
		headers,
		signal,
		lookup: (_hostname, _options, callback) => callback(null, [{ address, family }]),
	}, res => {
		const responseHeaders = new Headers();
		for (const [name, value] of Object.entries(res.headers)) {
			if (typeof value === 'string') {
				responseHeaders.set(name, value);
			}
		}
		const status = res.statusCode ?? 0;
		// Response.status must be 200–599; map anything else so the caller's status checks still see a failure.
		resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: status >= 200 && status <= 599 ? status : 599, headers: responseHeaders }));
	});
	req.on('error', reject);
	req.end();
});

/**
 * Non-public ranges. `BlockList` normalizes IPv4-mapped IPv6 (`::ffff:7f00:1`,
 * which is how the URL parser spells `[::ffff:127.0.0.1]`) against the IPv4
 * subnets, so the IPv4 list covers both spellings.
 */
const NON_PUBLIC = new BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
	['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
] as const) {
	NON_PUBLIC.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
	['::', 96], // unspecified, loopback and deprecated IPv4-compatible (::7f00:1)
	['64:ff9b::', 96], // NAT64
	['2002::', 16], // 6to4
	['fc00::', 7], // unique local
	['fe80::', 10], // link local
	['fec0::', 10], // deprecated site local
	['ff00::', 8], // multicast
] as const) {
	NON_PUBLIC.addSubnet(address, prefix, 'ipv6');
}

/** False for anything in {@link NON_PUBLIC} or not an IP literal at all. */
export function isPublicAddress(address: string): boolean {
	const kind = isIP(address);
	return kind !== 0 && !NON_PUBLIC.check(address, kind === 6 ? 'ipv6' : 'ipv4');
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) {
		return '';
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = '';
	let received = 0;
	try {
		while (received < maxBytes) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			received += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return text + decoder.decode();
}

export function htmlToText(html: string): FetchedPage {
	const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim() || null;
	const text = decodeEntities(
		html
			.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
			.replace(/<[^>]+>/g, ' '),
	)
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim()
		.slice(0, MAX_PAGE_CHARS);
	return { title, text };
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

// #endregion

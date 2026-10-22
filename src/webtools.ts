/**
 * Local implementations of Anthropic's hosted `web_search` / `web_fetch`
 * tools, which CAPI refuses. Kept behind an interface so the backend can be
 * swapped (Bing RSS needs no API key, which is why it is the default).
 */

import { VERSION } from './proxy.ts';

export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchOptions { allowedDomains?: string[] | undefined; blockedDomains?: string[] | undefined }
export interface FetchedPage { title: string | null; text: string }

export interface WebTools {
	search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult[]>;
	fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage>;
}

const MAX_RESULTS = 10;
const MAX_PAGE_CHARS = 100_000;
const USER_AGENT = `claudia/${VERSION}`;

export const defaultWebTools: WebTools = {
	async search(query, options, signal) {
		const url = `https://www.bing.com/search?format=rss&count=${MAX_RESULTS}&q=${encodeURIComponent(query)}`;
		const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, ...(signal ? { signal } : {}) });
		if (!response.ok) {
			throw new Error(`search backend returned HTTP ${response.status}`);
		}
		return filterByDomain(parseRss(await response.text()), options).slice(0, MAX_RESULTS);
	},

	async fetchPage(url, signal) {
		const target = new URL(url);
		if (!/^https?:$/.test(target.protocol) || !target.hostname.includes('.')) {
			throw new Error(`refusing to fetch ${url}: only public http(s) URLs are allowed`);
		}
		const response = await fetch(target, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html, text/plain;q=0.9, */*;q=0.5' }, redirect: 'follow', ...(signal ? { signal } : {}) });
		if (!response.ok) {
			throw new Error(`fetch returned HTTP ${response.status}`);
		}
		const body = await response.text();
		const isHtml = (response.headers.get('content-type') ?? '').includes('html') || /^\s*<(!doctype|html)/i.test(body);
		return isHtml ? htmlToText(body) : { title: null, text: body.slice(0, MAX_PAGE_CHARS) };
	},
};

export function parseRss(xml: string): SearchResult[] {
	const results: SearchResult[] = [];
	for (const item of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
		// Fields are XML-escaped and may themselves contain HTML (`&lt;b&gt;…`), hence strip → decode → strip.
		const pick = (name: string) => stripTags(decodeEntities(stripTags(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item[1]!)?.[1] ?? ''))).trim();
		const url = pick('link');
		if (url) {
			results.push({ title: pick('title'), url, snippet: pick('description') });
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

function stripTags(value: string): string {
	return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '');
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

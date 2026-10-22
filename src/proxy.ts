import type { Config } from './config.ts';
import type { UpstreamSession } from './github.ts';
import type { Logger } from './log.ts';

export const VERSION = '0.2.0';

/** Inbound request, already decoupled from Node's `http` so handlers are unit-testable. */
export interface ProxyRequest {
	readonly method: string;
	/** Path with any leading `/v1` already stripped, e.g. `/chat/completions`. */
	readonly path: string;
	readonly headers: Headers;
	readonly body: () => Promise<string>;
	/** Aborts when the client disconnects. */
	readonly signal: AbortSignal;
}

export interface ProxyContext {
	readonly config: Config;
	readonly session: UpstreamSession;
	readonly log: Logger;
	readonly requestId: string;
	readonly fetch: typeof globalThis.fetch;
}

export type RouteHandler = (request: ProxyRequest, ctx: ProxyContext) => Promise<Response>;

export interface Route {
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly handler: RouteHandler;
}

/**
 * Headers for every upstream call. Only `Authorization` is required by CAPI;
 * the rest identify this client and pin the API version.
 */
export function upstreamHeaders(ctx: ProxyContext): Record<string, string> {
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${ctx.session.token}`,
		'User-Agent': `claudia/${VERSION}`,
		'X-Request-Id': ctx.requestId,
		'X-GitHub-Api-Version': '2026-08-01',
		'OpenAI-Intent': 'conversation',
	};
	if (ctx.config.integrationId) {
		headers['Copilot-Integration-Id'] = ctx.config.integrationId;
	}
	return headers;
}

/** POST a JSON body to `${apiUrl}${path}` with the standard headers. */
export function postUpstream(ctx: ProxyContext, path: string, body: string, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
	return ctx.fetch(`${ctx.session.apiUrl}${path}`, {
		method: 'POST',
		headers: { ...upstreamHeaders(ctx), 'Content-Type': 'application/json', ...extraHeaders },
		body,
		...(signal ? { signal } : {}),
	});
}

/** Inbound headers relayed upstream. Anthropic clients version and feature-gate requests through these. */
export const RELAYED_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta'];

export function relayedHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of RELAYED_REQUEST_HEADERS) {
		const value = headers.get(name);
		if (value) {
			out[name] = value;
		}
	}
	return out;
}

/** Forward the JSON body byte-for-byte to `${apiUrl}${upstreamPath}`, returning CAPI's response as-is. */
export function passthrough(upstreamPath: string): RouteHandler {
	return async (request, ctx) => {
		const body = await request.body();
		ctx.log.debug(`[${ctx.requestId}] → POST ${upstreamPath} model=${peekModel(body) ?? '?'}`);
		return postUpstream(ctx, upstreamPath, body, relayedHeaders(request.headers), request.signal);
	};
}

export function peekModel(body: string): string | undefined {
	try {
		const model = (JSON.parse(body) as { model?: unknown }).model;
		return typeof model === 'string' ? model : undefined;
	} catch {
		return undefined;
	}
}

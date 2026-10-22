import type { Config } from './config.ts';
import type { UpstreamSession } from './github.ts';
import type { Logger } from './log.ts';

export const VERSION = '0.1.0';

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
 * The extension point: one line per OpenAI-compatible surface. CAPI speaks
 * the OpenAI wire format natively on each of these, so most routes are plain
 * passthroughs — add a handler only when translation is really needed.
 */
export const routes: readonly Route[] = [
	{ method: 'GET', path: '/models', handler: listModels },
	{ method: 'POST', path: '/chat/completions', handler: passthrough('/chat/completions') },
	{ method: 'POST', path: '/responses', handler: passthrough('/responses') },
];

/** Forward the JSON body byte-for-byte to `${apiUrl}${upstreamPath}`, returning CAPI's response as-is. */
export function passthrough(upstreamPath: string): RouteHandler {
	return async (request, ctx) => {
		const body = await request.body();
		ctx.log.debug(`[${ctx.requestId}] → POST ${upstreamPath} model=${peekModel(body) ?? '?'}`);
		return ctx.fetch(`${ctx.session.apiUrl}${upstreamPath}`, {
			method: 'POST',
			headers: { ...upstreamHeaders(ctx), 'Content-Type': 'application/json' },
			body,
			signal: request.signal,
		});
	};
}

export async function listModels(request: ProxyRequest, ctx: ProxyContext): Promise<Response> {
	const upstream = await ctx.fetch(`${ctx.session.apiUrl}/models`, {
		headers: upstreamHeaders(ctx),
		signal: request.signal,
	});
	if (!upstream.ok) {
		return upstream;
	}
	const { data = [] } = await upstream.json() as { data?: CapiModel[] };
	return Response.json(toOpenAIModelList(data));
}

/**
 * Headers for every upstream call. Only `Authorization` is required by CAPI;
 * the rest identify this client honestly and pin the API version.
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

/** Subset of CAPI's `/models` entry we rely on. */
export interface CapiModel {
	readonly id: string;
	readonly name?: string;
	readonly vendor?: string;
	readonly version?: string;
	readonly capabilities?: { readonly type?: string };
	readonly supported_endpoints?: readonly string[];
}

export interface OpenAIModel {
	readonly id: string;
	readonly object: 'model';
	readonly created: number;
	readonly owned_by: string;
	/** Non-standard hint: CAPI paths this model answers on. Empty means `/chat/completions`. */
	readonly supported_endpoints: readonly string[];
}

export function toOpenAIModelList(models: readonly CapiModel[]): { object: 'list'; data: OpenAIModel[] } {
	const data = models
		.filter(m => m.capabilities?.type === 'chat')
		.map((m): OpenAIModel => ({
			id: m.id,
			object: 'model',
			created: 0,
			owned_by: (m.vendor ?? 'unknown').toLowerCase().replace(/\s+/g, '-'),
			supported_endpoints: m.supported_endpoints ?? [],
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return { object: 'list', data };
}

function peekModel(body: string): string | undefined {
	try {
		const model = (JSON.parse(body) as { model?: unknown }).model;
		return typeof model === 'string' ? model : undefined;
	} catch {
		return undefined;
	}
}

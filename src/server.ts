import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { Config } from './config.ts';
import type { UpstreamResolver } from './github.ts';
import type { Logger } from './log.ts';
import type { ProxyRequest, Route } from './proxy.ts';
import { routes as defaultRoutes } from './routes.ts';

export interface ServerOptions {
	readonly config: Config;
	readonly upstream: UpstreamResolver;
	readonly log: Logger;
	readonly routes?: readonly Route[];
	readonly fetch?: typeof globalThis.fetch;
}

/** Upstream response headers safe to relay; everything else (notably `content-encoding`) is dropped because `fetch` already decoded the body. */
const RELAYED_RESPONSE_HEADERS = ['content-type', 'cache-control'];

export function createServer(options: ServerOptions): http.Server {
	const { config, upstream, log, routes = defaultRoutes, fetch = globalThis.fetch } = options;

	return http.createServer(async (req, res) => {
		const requestId = randomUUID();
		const startedAt = performance.now();
		const method = req.method ?? 'GET';
		const path = normalizePath(req.url ?? '/');
		const abort = new AbortController();
		res.on('close', () => abort.abort());

		try {
			const response = await dispatch(method, path, req, abort.signal, requestId);
			if (response.status === 401 || response.status === 403) {
				// Could be a rotated/revoked token — re-resolve on the next request.
				upstream.invalidate();
			}
			await writeResponse(res, response, requestId);
			log.info(`[${requestId}] ${method} ${path} → ${response.status} ${elapsed(startedAt)}`);
		} catch (err) {
			if (abort.signal.aborted) {
				log.info(`[${requestId}] ${method} ${path} → client disconnected ${elapsed(startedAt)}`);
				return;
			}
			log.error(`[${requestId}] ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
			if (res.headersSent) {
				res.destroy();
			} else {
				await writeResponse(res, errorResponse(502, 'api_error', `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`), requestId);
			}
		}
	});

	async function dispatch(method: string, path: string, req: http.IncomingMessage, signal: AbortSignal, requestId: string): Promise<Response> {
		if (method === 'GET' && (path === '/' || path === '/health')) {
			return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
		}
		if (!isAuthorized(req.headers, config.apiKey)) {
			return errorResponse(401, 'authentication_error', 'Invalid API key');
		}
		const matching = routes.filter(route => route.path === path);
		if (matching.length === 0) {
			return errorResponse(404, 'not_found_error', `No route for ${method} ${path}`);
		}
		const route = matching.find(candidate => candidate.method === method);
		if (!route) {
			return errorResponse(405, 'invalid_request_error', `${method} not allowed on ${path}`);
		}
		let body: Promise<string> | undefined;
		const request: ProxyRequest = {
			method,
			path,
			headers: new Headers(req.headers as Record<string, string>),
			// Memoized so a handler can inspect the body and still delegate to a passthrough.
			body: () => body ??= readBody(req),
			signal,
		};
		const session = await upstream.get();
		return route.handler(request, { config, session, log, requestId, fetch });
	}
}

/** Accepts both `/v1/chat/completions` (OpenAI SDK default) and bare `/chat/completions`. */
export function normalizePath(url: string): string {
	const { pathname } = new URL(url, 'http://localhost');
	const stripped = pathname.replace(/^\/v1(?=\/|$)/, '').replace(/\/+$/, '');
	return stripped === '' ? '/' : stripped;
}

/**
 * Constant-time key check accepting the OpenAI (`Authorization: Bearer`) and
 * Anthropic (`x-api-key`) conventions. An unset `apiKey` disables auth
 * (loopback-only deployments).
 */
export function isAuthorized(headers: { authorization?: string | undefined; 'x-api-key'?: string | string[] | undefined }, apiKey: string | undefined): boolean {
	if (!apiKey) {
		return true;
	}
	const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice('Bearer '.length) : undefined;
	const presented = bearer ?? (typeof headers['x-api-key'] === 'string' ? headers['x-api-key'] : undefined);
	if (presented === undefined) {
		return false;
	}
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(presented), digest(apiKey));
}

export function errorResponse(status: number, type: string, message: string): Response {
	return Response.json({ error: { message, type, code: null } }, { status });
}

async function writeResponse(res: http.ServerResponse, response: Response, requestId: string): Promise<void> {
	const headers: Record<string, string> = { 'X-Request-Id': requestId };
	for (const name of RELAYED_RESPONSE_HEADERS) {
		const value = response.headers.get(name);
		if (value) {
			headers[name] = value;
		}
	}
	res.writeHead(response.status, headers);
	if (!response.body) {
		res.end();
		return;
	}
	res.flushHeaders();
	await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res);
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function elapsed(startedAt: number): string {
	return `${Math.round(performance.now() - startedAt)}ms`;
}

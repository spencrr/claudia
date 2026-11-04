import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { isLoopback, type Config } from './config.ts';
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
		// Everything from here on is inside the error boundary: an unhandled rejection in this
		// callback would take the process down, and the request line is attacker-controlled.
		let path = req.url ?? '/';
		const abort = new AbortController();
		res.on('close', () => abort.abort());

		try {
			path = normalizePath(path);
			const response = await dispatch(method, path, req, abort.signal, requestId);
			await writeResponse(res, response, requestId);
			log.info(`[${requestId}] ${method} ${path} → ${response.status} ${elapsed(startedAt)}`);
		} catch (err) {
			if (abort.signal.aborted) {
				log.info(`[${requestId}] ${method} ${path} → client disconnected ${elapsed(startedAt)}`);
				return;
			}
			const failure = err instanceof RequestError
				? errorResponse(err.status, 'invalid_request_error', err.message)
				: errorResponse(502, 'api_error', `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`);
			log[failure.status >= 500 ? 'error' : 'info'](`[${requestId}] ${method} ${path} → ${failure.status} ${err instanceof Error ? err.message : String(err)}`);
			if (res.headersSent) {
				res.destroy();
			} else {
				// The client may already be gone; a failed error write must not escape the boundary.
				await writeResponse(res, failure, requestId).catch(() => res.destroy());
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
		if (!config.apiKey && !isLocalClient(req.headers)) {
			return errorResponse(403, 'permission_error', 'Without CLAUDIA_API_KEY only local, non-browser clients are accepted');
		}
		const response = await route(method, path, req, signal, requestId);
		if (response.status === 401 || response.status === 403) {
			// Only upstream verdicts reach here (our own 401/403 returned above), so the token may have been rotated or revoked.
			upstream.invalidate();
		}
		return response;
	}

	async function route(method: string, path: string, req: http.IncomingMessage, signal: AbortSignal, requestId: string): Promise<Response> {
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

/** A client-side failure that should be answered with `status` rather than treated as an upstream fault. */
export class RequestError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Largest request body accepted; generous enough for base64 images, small enough that one request cannot exhaust memory. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/** Accepts both `/v1/chat/completions` (OpenAI SDK default) and bare `/chat/completions`. */
export function normalizePath(url: string): string {
	let pathname: string;
	try {
		({ pathname } = new URL(url, 'http://localhost'));
	} catch {
		throw new RequestError(400, 'Malformed request target');
	}
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

/**
 * Keyless mode relies on "only this machine can reach the port", but a web
 * page the user has open can reach loopback too. Browsers send `Origin` on
 * every cross-origin request and a `Host` naming the (possibly rebound) site;
 * native clients send neither, so both are cheap discriminators.
 */
export function isLocalClient(headers: { host?: string | undefined; origin?: string | undefined }): boolean {
	if (headers.origin !== undefined) {
		return false;
	}
	let hostname: string;
	try {
		({ hostname } = new URL(`http://${headers.host ?? ''}`));
	} catch {
		return false;
	}
	return hostname.length > 0 && isLoopback(hostname);
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
	const declared = Number(req.headers['content-length']);
	if (declared > MAX_REQUEST_BODY_BYTES) {
		return Promise.reject(new RequestError(413, 'Request body too large'));
	}
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		req.on('data', (chunk: Buffer) => {
			received += chunk.length;
			if (received > MAX_REQUEST_BODY_BYTES) {
				// Also covers chunked bodies and lying Content-Length headers. Stop buffering
				// but leave the socket open so the 413 can be delivered.
				chunks.length = 0;
				req.removeAllListeners('data');
				req.resume();
				reject(new RequestError(413, 'Request body too large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function elapsed(startedAt: number): string {
	return `${Math.round(performance.now() - startedAt)}ms`;
}

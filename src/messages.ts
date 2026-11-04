/**
 * `POST /v1/messages` for every model in the catalog. Claude models pass
 * through to CAPI's native Anthropic endpoint; other vendors are translated to
 * the OpenAI surface CAPI serves them on. Anthropic's hosted `web_search` /
 * `web_fetch` tools, which CAPI rejects, are executed here instead.
 */

import {
	anthropicError,
	collectMessage,
	formatSse,
	isServerTool,
	messageToEvents,
	parseSse,
	type ContentBlock,
	type CustomTool,
	type Message,
	type MessagesRequest,
	type ServerTool,
	type StreamEvent,
	type ToolResultBlock,
	type ToolUseBlock,
	type Usage,
} from './anthropic.ts';
import { getCatalog, pickBackend, type Backend } from './catalog.ts';
import { chatToEvents, responsesToEvents, toChatRequest, toResponsesRequest } from './openai.ts';
import { passthrough, postUpstream, relayedHeaders, type ProxyContext, type ProxyRequest, type RouteHandler } from './proxy.ts';
import { createWebTools, type WebTools } from './webtools.ts';

// #region Backends

class UpstreamError extends Error {
	readonly status: number;
	constructor(status: number, body: string) {
		super(extractMessage(body) ?? `upstream HTTP ${status}`);
		this.status = status;
	}
}

function extractMessage(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
		return typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
	} catch {
		return body.trim() || undefined;
	}
}

interface Call {
	readonly req: MessagesRequest;
	readonly ctx: ProxyContext;
	readonly headers: Record<string, string>;
	readonly signal: AbortSignal;
}

/** Issue the upstream request and, once it is known to be 2xx, hand back the translated event stream. */
async function run(backend: Backend, call: Call): Promise<AsyncIterable<StreamEvent>> {
	const { req, ctx, signal } = call;
	const [path, body, translate] = backend === 'chat'
		? ['/chat/completions', toChatRequest(req), chatToEvents] as const
		: backend === 'responses'
			? ['/responses', toResponsesRequest(req), responsesToEvents] as const
			: ['/v1/messages', { ...req, stream: true }, nativeToEvents] as const;
	ctx.log.debug(`[${ctx.requestId}] → POST ${path} model=${req.model} backend=${backend}`);
	const response = await postUpstream(ctx, path, JSON.stringify(body), backend === 'messages' ? call.headers : {}, signal);
	if (!response.ok || !response.body) {
		throw new UpstreamError(response.status, await response.text().catch(() => ''));
	}
	return translate(parseSse(response.body), req.model);
}

async function* nativeToEvents(frames: AsyncIterable<{ data: string }>): AsyncGenerator<StreamEvent> {
	for await (const frame of frames) {
		try {
			yield JSON.parse(frame.data) as StreamEvent;
		} catch {
			continue;
		}
	}
}

async function resolveBackend(ctx: ProxyContext, model: string, signal: AbortSignal): Promise<Backend> {
	try {
		return pickBackend(model, await getCatalog(ctx, signal));
	} catch (err) {
		ctx.log.warn(`[${ctx.requestId}] model catalog unavailable (${err instanceof Error ? err.message : String(err)}); assuming Anthropic`);
		return 'messages';
	}
}

// #endregion

// #region Hosted tools executed locally

const HOSTED_TOOL_PREFIXES = ['web_search', 'web_fetch'] as const;
type HostedKind = (typeof HOSTED_TOOL_PREFIXES)[number];
const DEFAULT_MAX_USES = 5;
const MAX_TOOL_ROUNDS = 10;

function hostedKind(tool: ServerTool): HostedKind | undefined {
	return HOSTED_TOOL_PREFIXES.find(prefix => tool.type.startsWith(prefix));
}

/** The JSON-schema tool the model sees in place of the hosted one. */
function asCustomTool(tool: ServerTool, kind: HostedKind): CustomTool {
	return kind === 'web_search'
		? {
			name: tool.name,
			description: 'Search the web. Returns result titles, URLs and snippets.',
			input_schema: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search query' },
					allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' },
					blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude results from these domains' },
				},
				required: ['query'],
			},
		}
		: {
			name: tool.name,
			description: 'Fetch a public web page and return its text content.',
			input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' } }, required: ['url'] },
		};
}

interface ToolOutcome { blocks: ContentBlock[]; text: string }

async function execute(kind: HostedKind, call: ToolUseBlock, tools: WebTools, signal: AbortSignal): Promise<ToolOutcome> {
	const use: ContentBlock = { type: 'server_tool_use', id: call.id, name: call.name, input: call.input };
	const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
	try {
		if (kind === 'web_search') {
			const query = String(call.input.query ?? '');
			const results = await tools.search(query, { allowedDomains: strings(call.input.allowed_domains), blockedDomains: strings(call.input.blocked_domains) }, signal);
			return {
				blocks: [use, {
					type: 'web_search_tool_result',
					tool_use_id: call.id,
					content: results.map(r => ({ type: 'web_search_result', title: r.title, url: r.url, encrypted_content: '', page_age: r.pageAge })),
				}],
				text: results.length === 0
					? `No results for "${query}".`
					: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.pageAge ? ` (updated ${r.pageAge})` : ''}\n   ${r.snippet}`).join('\n\n'),
			};
		}
		const url = String(call.input.url ?? '');
		const page = await tools.fetchPage(url, signal);
		return {
			blocks: [use, {
				type: 'web_fetch_tool_result',
				tool_use_id: call.id,
				content: {
					type: 'web_fetch_result',
					url,
					retrieved_at: new Date().toISOString(),
					content: { type: 'document', title: page.title, source: { type: 'text', media_type: 'text/plain', data: page.text } },
				},
			}],
			text: page.title ? `# ${page.title}\n\n${page.text}` : page.text,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			blocks: [use, { type: `${kind}_tool_result`, tool_use_id: call.id, content: { type: `${kind}_tool_result_error`, error_code: 'unavailable' } }],
			text: `${kind} failed: ${message}`,
		};
	}
}

/**
 * Run the model with hosted tools swapped for local ones, executing calls in
 * a bounded loop. The final message presents the work in Anthropic's hosted
 * tool block shapes so clients (Claude Code included) render it natively.
 */
async function runWithHostedTools(backend: Backend, call: Call, hosted: ServerTool[], tools: WebTools): Promise<Message> {
	const kinds = new Map(hosted.map(tool => [tool.name, hostedKind(tool)!] as const));
	const budget = Math.min(MAX_TOOL_ROUNDS, hosted.reduce((sum, tool) => sum + (tool.max_uses ?? DEFAULT_MAX_USES), 0));
	const localTools = hosted.map(tool => asCustomTool(tool, kinds.get(tool.name)!));
	let working: MessagesRequest = { ...call.req, stream: false, tools: [...(call.req.tools ?? []).filter(tool => !isServerTool(tool)), ...localTools] };
	const executed: ContentBlock[] = [];
	const usage: Usage = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } };

	for (let round = 0; ; round++) {
		const message = await collectMessage(await run(backend, { ...call, req: working }), call.req.model);
		usage.input_tokens += message.usage.input_tokens;
		usage.output_tokens += message.usage.output_tokens;
		const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use' && kinds.has((block as ToolUseBlock).name));
		if (calls.length === 0 || round >= budget) {
			return {
				...message,
				content: [...executed, ...message.content.filter(block => !calls.includes(block as ToolUseBlock))],
				usage,
			};
		}
		const results: ToolResultBlock[] = [];
		for (const toolCall of calls) {
			const kind = kinds.get(toolCall.name)!;
			call.ctx.log.info(`[${call.ctx.requestId}] ${kind} ${JSON.stringify(toolCall.input)}`);
			const outcome = await execute(kind, toolCall, tools, call.signal);
			usage.server_tool_use![kind === 'web_search' ? 'web_search_requests' : 'web_fetch_requests']! += 1;
			executed.push(...outcome.blocks);
			results.push({ type: 'tool_result', tool_use_id: toolCall.id, content: outcome.text });
		}
		working = { ...working, messages: [...working.messages, { role: 'assistant', content: message.content }, { role: 'user', content: results }] };
	}
}

// #endregion

// #region Handlers

export interface MessagesOptions {
	/** Override the per-session web tools (tests). Defaults to GitHub web search + local fetch on the session's token. */
	readonly webTools?: WebTools;
}

export function createMessagesHandler({ webTools }: MessagesOptions = {}): RouteHandler {
	return async (request, ctx) => {
		const parsed = await parseRequest(request);
		if (parsed instanceof Response) {
			return parsed;
		}
		const backend = await resolveBackend(ctx, parsed.model, request.signal);
		const hosted = (parsed.tools ?? []).filter((tool): tool is ServerTool => isServerTool(tool) && hostedKind(tool) !== undefined);
		if (backend === 'messages' && hosted.length === 0) {
			return passthrough('/v1/messages')(request, ctx);
		}

		const call: Call = { req: parsed, ctx, headers: relayedHeaders(request.headers), signal: request.signal };
		try {
			if (hosted.length > 0) {
				const tools = webTools ?? createWebTools({ apiUrl: ctx.session.apiUrl, token: ctx.session.token, fetch: ctx.fetch });
				const message = await runWithHostedTools(backend, call, hosted, tools);
				return parsed.stream ? sseResponse(messageToEvents(message)) : Response.json(message);
			}
			if (parsed.stream) {
				return sseResponse(await run(backend, call));
			}
			return Response.json(await collectMessage(await run(backend, call), parsed.model));
		} catch (err) {
			if (err instanceof UpstreamError) {
				return anthropicError(err.status, err.message);
			}
			throw err;
		}
	};
}

/** CAPI counts tokens for Claude only; other vendors get a size-based estimate. */
export const countTokens: RouteHandler = async (request, ctx) => {
	const parsed = await parseRequest(request);
	if (parsed instanceof Response) {
		return parsed;
	}
	if (await resolveBackend(ctx, parsed.model, request.signal) === 'messages') {
		return passthrough('/v1/messages/count_tokens')(request, ctx);
	}
	const size = JSON.stringify({ system: parsed.system, messages: parsed.messages, tools: parsed.tools }).length;
	return Response.json({ input_tokens: Math.ceil(size / 4) });
};

async function parseRequest(request: ProxyRequest): Promise<MessagesRequest | Response> {
	let body: unknown;
	try {
		body = JSON.parse(await request.body());
	} catch {
		return anthropicError(400, 'Request body is not valid JSON');
	}
	const req = body as Partial<MessagesRequest> | null;
	if (!req || typeof req !== 'object' || typeof req.model !== 'string' || !Array.isArray(req.messages)) {
		return anthropicError(400, 'Request must include "model" and "messages"');
	}
	return req as MessagesRequest;
}

function sseResponse(events: Iterable<StreamEvent> | AsyncIterable<StreamEvent>): Response {
	const encoder = new TextEncoder();
	const body = ReadableStream.from((async function* () {
		try {
			for await (const event of events) {
				yield encoder.encode(formatSse(event));
			}
		} catch (err) {
			yield encoder.encode(formatSse({ type: 'error', error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) } }));
		}
	})());
	return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

// #endregion

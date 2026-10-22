import { getCatalog, type CapiModel } from './catalog.ts';
import { countTokens, createMessagesHandler } from './messages.ts';
import { passthrough, type ProxyContext, type ProxyRequest, type Route } from './proxy.ts';

/**
 * The extension point: one line per API surface. CAPI speaks both the OpenAI
 * and Anthropic wire formats natively, so most routes are plain passthroughs;
 * `/messages` adds cross-vendor translation and local hosted tools.
 */
export const routes: readonly Route[] = [
	{ method: 'GET', path: '/models', handler: listModels },
	// OpenAI
	{ method: 'POST', path: '/chat/completions', handler: passthrough('/chat/completions') },
	{ method: 'POST', path: '/responses', handler: passthrough('/responses') },
	// Anthropic Messages API (Claude Code, Anthropic SDKs) for every catalog model.
	{ method: 'POST', path: '/messages', handler: createMessagesHandler() },
	{ method: 'POST', path: '/messages/count_tokens', handler: countTokens },
];

export async function listModels(request: ProxyRequest, ctx: ProxyContext): Promise<Response> {
	return Response.json(toOpenAIModelList(await getCatalog(ctx, request.signal)));
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

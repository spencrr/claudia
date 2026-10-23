import { upstreamHeaders, type ProxyContext } from './proxy.ts';

/** Subset of CAPI's `/models` entry we rely on. */
export interface CapiModel {
	readonly id: string;
	readonly name?: string;
	readonly vendor?: string;
	readonly version?: string;
	readonly capabilities?: {
		readonly type?: string;
		readonly limits?: { readonly max_context_window_tokens?: number; readonly max_output_tokens?: number };
		readonly supports?: { readonly tool_calls?: boolean; readonly vision?: boolean };
	};
	readonly supported_endpoints?: readonly string[];
}

/** Which CAPI surface a model answers on; CAPI does not translate between them. */
export type Backend = 'messages' | 'chat' | 'responses';

const CATALOG_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { models: CapiModel[]; expiresAt: number }>();

/** CAPI's model list for the session's endpoint, cached per API URL. */
export async function getCatalog(ctx: ProxyContext, signal?: AbortSignal): Promise<CapiModel[]> {
	const key = ctx.session.apiUrl;
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.models;
	}
	const response = await ctx.fetch(`${key}/models`, { headers: upstreamHeaders(ctx), ...(signal ? { signal } : {}) });
	if (!response.ok) {
		throw new Error(`CAPI /models failed: HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
	}
	const { data = [] } = await response.json() as { data?: CapiModel[] };
	cache.set(key, { models: data, expiresAt: Date.now() + CATALOG_TTL_MS });
	return data;
}

export function clearCatalogCache(): void {
	cache.clear();
}

/**
 * Pick the backend for a model. Claude models (and anything unknown) go to the
 * native Anthropic endpoint so CAPI's own error surfaces for bad IDs; other
 * vendors route by their advertised endpoints, where an empty list means
 * legacy `/chat/completions`.
 */
export function pickBackend(modelId: string, catalog: readonly CapiModel[]): Backend {
	const wanted = normalizeModelId(modelId);
	const model = catalog.find(m => normalizeModelId(m.id) === wanted);
	if (!model) {
		return 'messages';
	}
	if (model.vendor?.toLowerCase() === 'anthropic' || model.id.startsWith('claude')) {
		return 'messages';
	}
	return model.supported_endpoints?.includes('/responses') ? 'responses' : 'chat';
}

/** `claude-sonnet-5-5-20260101` and `claude-sonnet-5.5` compare equal: drop date suffixes, dot the minor version. */
export function normalizeModelId(id: string): string {
	return id.toLowerCase().replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)(?=$|-)/, '-$1.$2');
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';

const execFileAsync = promisify(execFile);

/** Everything a request needs to reach Copilot: who we are and where CAPI lives. */
export interface UpstreamSession {
	readonly token: string;
	/** CAPI base URL, e.g. `https://api.githubcopilot.com` — no trailing slash. */
	readonly apiUrl: string;
	readonly login: string | undefined;
	readonly plan: string | undefined;
}

export interface UpstreamResolver {
	/** Returns the cached session, (re)building it when missing or expired. */
	get(): Promise<UpstreamSession>;
	/** Drop the cache so the next `get()` re-resolves the token and endpoints. */
	invalidate(): void;
}

export interface UpstreamDeps {
	readonly fetch: typeof globalThis.fetch;
	readonly resolveToken: (configured: string | undefined) => Promise<string>;
	readonly now: () => number;
}

const DEFAULT_CAPI_URL = 'https://api.githubcopilot.com';
const USER_API_VERSION = '2025-04-01';
const SESSION_TTL_MS = 30 * 60 * 1000;

/** `GITHUB_TOKEN` wins; otherwise borrow the token the GitHub CLI is signed in with. */
export async function resolveGitHubToken(configured: string | undefined): Promise<string> {
	if (configured) {
		return configured;
	}
	let token = '';
	try {
		const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000, windowsHide: true });
		token = stdout.trim();
	} catch (err) {
		throw new Error(`No GitHub token: set GITHUB_TOKEN or run \`gh auth login\` (${describe(err)})`);
	}
	if (!token) {
		throw new Error('No GitHub token: `gh auth token` returned nothing; set GITHUB_TOKEN or run `gh auth login`');
	}
	return token;
}

/**
 * Builds a resolver that caches the session for {@link SESSION_TTL_MS} (CAPI
 * endpoints rarely move) and lets the server invalidate it on 401/403.
 */
export function createUpstreamResolver(config: Config, log: Logger, deps: Partial<UpstreamDeps> = {}): UpstreamResolver {
	const { fetch, resolveToken, now }: UpstreamDeps = {
		fetch: globalThis.fetch,
		resolveToken: resolveGitHubToken,
		now: Date.now,
		...deps,
	};
	let cached: { session: UpstreamSession; expiresAt: number } | undefined;
	let pending: Promise<UpstreamSession> | undefined;

	const build = async (): Promise<UpstreamSession> => {
		const token = await resolveToken(config.githubToken);
		if (config.capiUrl) {
			log.info(`using CAPI URL override ${config.capiUrl}; skipping endpoint discovery`);
			return { token, apiUrl: config.capiUrl, login: undefined, plan: undefined };
		}
		const session = await discover(config.githubApiUrl, token, fetch);
		log.info(`Copilot session: login=${session.login ?? '?'} plan=${session.plan ?? '?'} api=${session.apiUrl}`);
		return session;
	};

	return {
		get() {
			if (cached && cached.expiresAt > now()) {
				return Promise.resolve(cached.session);
			}
			pending ??= build()
				.then(session => {
					cached = { session, expiresAt: now() + SESSION_TTL_MS };
					return session;
				})
				.finally(() => { pending = undefined; });
			return pending;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

interface CopilotUserResponse {
	readonly login?: string;
	readonly copilot_plan?: string;
	readonly endpoints?: { readonly api?: string };
}

async function discover(githubApiUrl: string, token: string, fetch: typeof globalThis.fetch): Promise<UpstreamSession> {
	const response = await fetch(`${githubApiUrl}/copilot_internal/user`, {
		headers: {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json',
			'X-GitHub-Api-Version': USER_API_VERSION,
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Copilot endpoint discovery failed: HTTP ${response.status} ${body.slice(0, 200)}`);
	}
	const user = await response.json() as CopilotUserResponse;
	return {
		token,
		apiUrl: (user.endpoints?.api ?? DEFAULT_CAPI_URL).replace(/\/+$/, ''),
		login: user.login,
		plan: user.copilot_plan,
	};
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

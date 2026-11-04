import { LOG_LEVELS, type LogLevel } from './log.ts';

export interface Config {
	/** Interface to bind. Anything other than loopback requires `apiKey`. */
	readonly host: string;
	readonly port: number;
	/** When set, clients must send `Authorization: Bearer <apiKey>`. */
	readonly apiKey: string | undefined;
	/** GitHub OAuth token. When unset, resolved from `gh auth token`. */
	readonly githubToken: string | undefined;
	/** `gh` account to borrow the token from (`gh auth token -u <user>`); defaults to the active one. */
	readonly githubUser: string | undefined;
	/** GitHub REST API base used for Copilot endpoint discovery. */
	readonly githubApiUrl: string;
	/** Skip discovery and send every upstream call to this base URL (debug/testing). */
	readonly capiUrl: string | undefined;
	/**
	 * `Copilot-Integration-Id` sent upstream. CAPI gates part of the catalog on
	 * it (e.g. `gpt-5.6-sol-fast`, Gemini) — without it those models 400.
	 * `undefined` omits the header.
	 */
	readonly integrationId: string | undefined;
	readonly logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const config: Config = {
		host: env.CLAUDIA_HOST || '127.0.0.1',
		port: parsePort(env.CLAUDIA_PORT || '4242'),
		apiKey: env.CLAUDIA_API_KEY || undefined,
		githubToken: env.GITHUB_TOKEN || undefined,
		githubUser: env.CLAUDIA_GITHUB_USER || undefined,
		githubApiUrl: tokenDestination('CLAUDIA_GITHUB_API_URL', env.CLAUDIA_GITHUB_API_URL || 'https://api.github.com'),
		capiUrl: env.CLAUDIA_CAPI_URL ? tokenDestination('CLAUDIA_CAPI_URL', env.CLAUDIA_CAPI_URL) : undefined,
		integrationId: parseIntegrationId(env.CLAUDIA_INTEGRATION_ID),
		logLevel: parseLogLevel(env.CLAUDIA_LOG_LEVEL || 'info'),
	};
	if (!isLoopback(config.host) && !config.apiKey) {
		throw new Error(`CLAUDIA_HOST=${config.host} is not loopback; set CLAUDIA_API_KEY to protect your Copilot credits`);
	}
	return config;
}

export function isLoopback(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`CLAUDIA_PORT must be an integer in 1..65535, got "${value}"`);
	}
	return port;
}

function parseLogLevel(value: string): LogLevel {
	if (!(LOG_LEVELS as readonly string[]).includes(value)) {
		throw new Error(`CLAUDIA_LOG_LEVEL must be one of ${LOG_LEVELS.join('|')}, got "${value}"`);
	}
	return value as LogLevel;
}

/** Defaults to what the Copilot Chat extension sends; `none` opts out of the header entirely. */
function parseIntegrationId(value: string | undefined): string | undefined {
	if (value === undefined || value === '') {
		return 'vscode-chat';
	}
	return value === 'none' ? undefined : value;
}

/**
 * A base URL the Copilot token will be sent to. Must be `https:`; plain
 * `http:` is allowed only for loopback hosts (local test doubles), so a
 * mistyped override cannot put the token on the wire in clear text.
 */
export function tokenDestination(name: string, value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute URL, got "${value}"`);
	}
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
		throw new Error(`${name} must use https (http is allowed for loopback only): ${value}`);
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(`${name} must not carry credentials, a query or a fragment: ${value}`);
	}
	return url.origin + url.pathname.replace(/\/+$/, '');
}

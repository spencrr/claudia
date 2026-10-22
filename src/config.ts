import { LOG_LEVELS, type LogLevel } from './log.ts';

export interface Config {
	/** Interface to bind. Anything other than loopback requires `apiKey`. */
	readonly host: string;
	readonly port: number;
	/** When set, clients must send `Authorization: Bearer <apiKey>`. */
	readonly apiKey: string | undefined;
	/** GitHub OAuth token. When unset, resolved from `gh auth token`. */
	readonly githubToken: string | undefined;
	/** GitHub REST API base used for Copilot endpoint discovery. */
	readonly githubApiUrl: string;
	/** Skip discovery and send every upstream call to this base URL (debug/testing). */
	readonly capiUrl: string | undefined;
	/** Optional `Copilot-Integration-Id`; some SKUs expose extra models for `vscode-chat`. */
	readonly integrationId: string | undefined;
	readonly logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const config: Config = {
		host: env.CLAUDIA_HOST || '127.0.0.1',
		port: parsePort(env.CLAUDIA_PORT || '4242'),
		apiKey: env.CLAUDIA_API_KEY || undefined,
		githubToken: env.GITHUB_TOKEN || undefined,
		githubApiUrl: stripTrailingSlash(env.CLAUDIA_GITHUB_API_URL || 'https://api.github.com'),
		capiUrl: env.CLAUDIA_CAPI_URL ? stripTrailingSlash(env.CLAUDIA_CAPI_URL) : undefined,
		integrationId: env.CLAUDIA_INTEGRATION_ID || undefined,
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

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, '');
}

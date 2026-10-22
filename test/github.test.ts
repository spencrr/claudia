import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createUpstreamResolver, resolveGitHubToken } from '../src/github.ts';
import { silentLogger } from '../src/log.ts';

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
	const calls: { url: string; init: RequestInit | undefined }[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, init);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const userResponse = () => Response.json({
	login: 'octocat',
	copilot_plan: 'enterprise',
	endpoints: { api: 'https://api.enterprise.githubcopilot.com/' },
});

describe('resolveGitHubToken', () => {
	test('prefers an explicit GITHUB_TOKEN over the gh CLI', async () => {
		assert.equal(await resolveGitHubToken({ githubToken: 'gho_explicit', githubUser: 'ignored' }), 'gho_explicit');
	});

	test('fails clearly when the requested gh account does not exist', async () => {
		await assert.rejects(
			resolveGitHubToken({ githubToken: undefined, githubUser: 'no-such-user-claudia-test' }),
			/No GitHub token/,
		);
	});
});

describe('createUpstreamResolver', () => {
	test('discovers the CAPI endpoint with the GitHub token and caches it', async () => {
		const { fetch, calls } = fakeFetch(userResponse);
		const resolver = createUpstreamResolver(loadConfig({}), silentLogger, {
			fetch,
			resolveToken: async () => 'gho_test',
		});

		const session = await resolver.get();
		assert.equal(session.token, 'gho_test');
		assert.equal(session.apiUrl, 'https://api.enterprise.githubcopilot.com');
		assert.equal(session.login, 'octocat');
		assert.equal(session.plan, 'enterprise');

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, 'https://api.github.com/copilot_internal/user');
		const headers = calls[0]?.init?.headers as Record<string, string>;
		assert.equal(headers['Authorization'], 'Bearer gho_test');
		assert.equal(headers['X-GitHub-Api-Version'], '2025-04-01');

		await resolver.get();
		assert.equal(calls.length, 1, 'second get() served from cache');
	});

	test('concurrent get() calls share one discovery', async () => {
		const { fetch, calls } = fakeFetch(userResponse);
		const resolver = createUpstreamResolver(loadConfig({}), silentLogger, { fetch, resolveToken: async () => 't' });
		await Promise.all([resolver.get(), resolver.get(), resolver.get()]);
		assert.equal(calls.length, 1);
	});

	test('invalidate() and TTL expiry force re-discovery', async () => {
		let now = 1_000_000;
		const { fetch, calls } = fakeFetch(userResponse);
		const resolver = createUpstreamResolver(loadConfig({}), silentLogger, {
			fetch,
			resolveToken: async () => 't',
			now: () => now,
		});
		await resolver.get();
		resolver.invalidate();
		await resolver.get();
		assert.equal(calls.length, 2, 'invalidate() refetches');

		now += 31 * 60 * 1000;
		await resolver.get();
		assert.equal(calls.length, 3, 'TTL expiry refetches');
	});

	test('falls back to the public CAPI URL when discovery omits endpoints', async () => {
		const { fetch } = fakeFetch(() => Response.json({ login: 'x' }));
		const resolver = createUpstreamResolver(loadConfig({}), silentLogger, { fetch, resolveToken: async () => 't' });
		assert.equal((await resolver.get()).apiUrl, 'https://api.githubcopilot.com');
	});

	test('CLAUDIA_CAPI_URL skips discovery entirely', async () => {
		const { fetch, calls } = fakeFetch(userResponse);
		const config = loadConfig({ CLAUDIA_CAPI_URL: 'http://127.0.0.1:1234', GITHUB_TOKEN: 'env-token' });
		const resolver = createUpstreamResolver(config, silentLogger, { fetch });
		const session = await resolver.get();
		assert.equal(session.apiUrl, 'http://127.0.0.1:1234');
		assert.equal(session.token, 'env-token');
		assert.equal(calls.length, 0);
	});

	test('surfaces discovery failures and does not poison the cache', async () => {
		let status = 401;
		const { fetch, calls } = fakeFetch(() => status === 200 ? userResponse() : new Response('nope', { status }));
		const resolver = createUpstreamResolver(loadConfig({}), silentLogger, { fetch, resolveToken: async () => 't' });
		await assert.rejects(resolver.get(), /HTTP 401/);
		status = 200;
		assert.equal((await resolver.get()).login, 'octocat');
		assert.equal(calls.length, 2);
	});
});

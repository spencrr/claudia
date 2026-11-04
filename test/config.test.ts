import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isLoopback, loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
	test('applies defaults', () => {
		const config = loadConfig({});
		assert.equal(config.host, '127.0.0.1');
		assert.equal(config.port, 4242);
		assert.equal(config.apiKey, undefined);
		assert.equal(config.githubUser, undefined);
		assert.equal(config.githubApiUrl, 'https://api.github.com');
		assert.equal(config.capiUrl, undefined);
		assert.equal(config.integrationId, 'vscode-chat');
		assert.equal(config.logLevel, 'info');
	});

	test('CLAUDIA_INTEGRATION_ID overrides or disables the header', () => {
		assert.equal(loadConfig({ CLAUDIA_INTEGRATION_ID: 'custom-id' }).integrationId, 'custom-id');
		assert.equal(loadConfig({ CLAUDIA_INTEGRATION_ID: 'none' }).integrationId, undefined);
	});

	test('reads overrides and strips trailing slashes from URLs', () => {
		const config = loadConfig({
			CLAUDIA_PORT: '8080',
			CLAUDIA_API_KEY: 'secret',
			GITHUB_TOKEN: 'gho_x',
			CLAUDIA_GITHUB_USER: 'octocat',
			CLAUDIA_GITHUB_API_URL: 'https://api.acme.ghe.com/',
			CLAUDIA_CAPI_URL: 'http://127.0.0.1:9999/',
			CLAUDIA_LOG_LEVEL: 'debug',
		});
		assert.equal(config.port, 8080);
		assert.equal(config.apiKey, 'secret');
		assert.equal(config.githubToken, 'gho_x');
		assert.equal(config.githubUser, 'octocat');
		assert.equal(config.githubApiUrl, 'https://api.acme.ghe.com');
		assert.equal(config.capiUrl, 'http://127.0.0.1:9999');
		assert.equal(config.logLevel, 'debug');
	});

	test('rejects invalid port and log level', () => {
		assert.throws(() => loadConfig({ CLAUDIA_PORT: '0' }), /CLAUDIA_PORT/);
		assert.throws(() => loadConfig({ CLAUDIA_PORT: 'abc' }), /CLAUDIA_PORT/);
		assert.throws(() => loadConfig({ CLAUDIA_LOG_LEVEL: 'verbose' }), /CLAUDIA_LOG_LEVEL/);
	});

	test('token destinations must be https, or http on loopback only', () => {
		assert.equal(loadConfig({ CLAUDIA_CAPI_URL: 'http://127.0.0.1:9999/' }).capiUrl, 'http://127.0.0.1:9999');
		assert.equal(loadConfig({ CLAUDIA_CAPI_URL: 'http://localhost:9999' }).capiUrl, 'http://localhost:9999');
		assert.equal(loadConfig({ CLAUDIA_GITHUB_API_URL: 'https://api.acme.ghe.com/' }).githubApiUrl, 'https://api.acme.ghe.com');
		for (const [name, value] of [
			['CLAUDIA_CAPI_URL', 'http://capi.example.com'],
			['CLAUDIA_CAPI_URL', 'http://192.168.1.5:4242'],
			['CLAUDIA_GITHUB_API_URL', 'http://api.github.com'],
			['CLAUDIA_CAPI_URL', 'ftp://capi.example.com'],
			['CLAUDIA_CAPI_URL', 'not a url'],
			['CLAUDIA_CAPI_URL', 'https://user:pw@capi.example.com'],
			['CLAUDIA_CAPI_URL', 'https://capi.example.com/?x=1'],
		] as const) {
			assert.throws(() => loadConfig({ [name]: value }), new RegExp(name), `${name}=${value}`);
		}
	});

	test('refuses a non-loopback bind without an API key', () => {
		assert.throws(() => loadConfig({ CLAUDIA_HOST: '0.0.0.0' }), /CLAUDIA_API_KEY/);
		assert.doesNotThrow(() => loadConfig({ CLAUDIA_HOST: '0.0.0.0', CLAUDIA_API_KEY: 'k' }));
	});
});

describe('isLoopback', () => {
	test('recognises loopback forms', () => {
		for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
			assert.equal(isLoopback(host), true, host);
		}
	});
	test('rejects everything else', () => {
		for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com', '']) {
			assert.equal(isLoopback(host), false, host);
		}
	});
});

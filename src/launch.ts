import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { normalizeModelId } from './catalog.ts';
import type { Config } from './config.ts';
import { createUpstreamResolver } from './github.ts';
import { createLogger } from './log.ts';
import type { OpenAIModel } from './routes.ts';
import { createServer } from './server.ts';

/** The proxy a launched client talks to: reused if already running, otherwise private to the launcher. */
export interface Proxy {
	readonly url: string;
	readonly apiKey: string | undefined;
	close(): void;
}

/**
 * A claudia already listening on the configured address, or one started here
 * on an ephemeral loopback port. The private one lives exactly as long as the
 * launcher, which is why it is never bound to the shared port: a second
 * launcher must not adopt a server that disappears with the first.
 */
export async function ensureProxy(config: Config, fetchFn = globalThis.fetch): Promise<Proxy> {
	const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
	const configured = `http://${host}:${config.port}`;
	const running = await fetchFn(`${configured}/health`).then(response => response.ok && response.headers.get('server') === 'claudia', () => false);
	if (running) {
		return { url: configured, apiKey: config.apiKey, close() { } };
	}
	const log = createLogger('error'); // the client owns the terminal; only failures may write to it
	const upstream = createUpstreamResolver(config, log);
	await upstream.get(); // fail here, with a readable message, rather than inside the client's first request
	const server = createServer({ config, upstream, log });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		apiKey: config.apiKey,
		close: () => { server.closeAllConnections(); server.close(); },
	};
}

export async function fetchCatalog(proxy: Proxy, fetchFn = globalThis.fetch): Promise<OpenAIModel[]> {
	const response = await fetchFn(`${proxy.url}/v1/models`, { headers: proxy.apiKey ? { authorization: `Bearer ${proxy.apiKey}` } : {} });
	if (!response.ok) {
		throw new Error(`${proxy.url}/v1/models answered HTTP ${response.status}${response.status === 401 ? ' (set CLAUDIA_API_KEY to the running server\'s key)' : ''}`);
	}
	return ((await response.json()) as { data: OpenAIModel[] }).data;
}

/** `--model x`, `--model=x` or `-m x` from a client's own arguments; the launcher forwards them untouched. */
export function peekModel(args: readonly string[]): string | undefined {
	for (const [index, arg] of args.entries()) {
		if (arg === '--model' || arg === '-m') {
			return args[index + 1];
		}
		if (arg.startsWith('--model=')) {
			return arg.slice('--model='.length);
		}
	}
	return undefined;
}

/** Claude Code resolves bare aliases (`sonnet`, `opus[1m]`, …) itself, so only concrete ids are checked. */
const CLAUDE_ALIAS = /^[a-z]+(\[1m\])?$/;

/**
 * Environment for Claude Code: point it at the proxy and do the README's
 * manual steps. Settings already present in `base` win, except the two that
 * define the proxy itself.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, proxy: Proxy, catalog: readonly OpenAIModel[], model: string | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	delete env.ANTHROPIC_API_KEY; // Claude Code would prefer it to the proxy token
	env.ANTHROPIC_BASE_URL = proxy.url;
	env.ANTHROPIC_AUTH_TOKEN = proxy.apiKey ?? 'unused';
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1'; // update checks and telemetry would only hit the proxy's 404s
	const haiku = catalog.find(m => m.id.startsWith('claude-haiku'));
	if (haiku) {
		env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??= haiku.id; // background tasks; Claude Code's own default is not in the catalog
	}
	const chosen = model ?? env.ANTHROPIC_MODEL;
	if (chosen && !CLAUDE_ALIAS.test(chosen)) {
		const entry = catalog.find(m => normalizeModelId(m.id) === normalizeModelId(chosen));
		if (!entry) {
			// Names the source rather than echoing an environment value into the terminal.
			throw new Error(`${model ? `--model ${model}` : 'ANTHROPIC_MODEL'} is not in the Copilot catalog. Available:\n  ${catalog.map(m => m.id).join('\n  ')}`);
		}
		if (!chosen.startsWith('claude-') && entry.context_window) {
			env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ??= String(entry.context_window); // Claude Code assumes 200k for ids it does not know
		}
	}
	return env;
}

/** Hand the terminal to the client and resolve with its exit code. */
export function runClient(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve, reject) => {
		const file = process.platform === 'win32' ? findOnWindowsPath(command, env) : command;
		if (!file) {
			reject(new Error(`${command} is not on PATH`));
			return;
		}
		// Batch shims (npm's claude.cmd) only run through cmd.exe, which needs the arguments pre-quoted.
		const shell = /\.(cmd|bat)$/i.test(file);
		const child = spawn(shell ? quoteForCmd(file) : file, shell ? args.map(quoteForCmd) : args, { stdio: 'inherit', env, shell });
		child.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new Error(`${command} is not on PATH`) : err));
		// Only a process that actually started gets to report an exit code; a failed spawn may emit 'exit' too.
		child.once('spawn', () => child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0))));
	});
}

/** spawn() on Windows only finds .exe/.com on PATH; npm installs its shims as .cmd. */
function findOnWindowsPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
	if (/[\\/]/.test(command)) {
		return existsSync(command) ? command : undefined;
	}
	const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
	for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
		const found = extensions.map(ext => path.join(dir, command + ext.toLowerCase())).find(candidate => existsSync(candidate));
		if (found) {
			return found;
		}
	}
	return undefined;
}

// shortcut: MSVC argv quoting only; cmd.exe metacharacters (%, ^, &) inside an argument are not escaped.
export function quoteForCmd(arg: string): string {
	if (!/[\s"]/.test(arg)) {
		return arg;
	}
	// Backslashes are literal except before a quote or the closing quote, where they must be doubled.
	return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

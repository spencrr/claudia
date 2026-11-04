#!/usr/bin/env node
/**
 * claudia                   run the proxy (same as `node src/main.ts`)
 * claudia claude [args…]    launch Claude Code through claudia; args go to claude
 * claudia codex [args…]     launch Codex through claudia; args go to codex
 *
 * The launcher reuses a claudia already listening on CLAUDIA_HOST:CLAUDIA_PORT,
 * otherwise runs one inside this process for as long as the client lives.
 */
import { loadConfig } from './config.ts';
import { claudeEnv, codexArgs, codexEnv, ensureProxy, fetchCatalog, peekModel, runClient } from './launch.ts';

const USAGE = 'usage: claudia [serve | claude [args…] | codex [args…]]';
const [command = 'serve', ...args] = process.argv.slice(2);

try {
	switch (command) {
		case 'serve':
			await import('./main.ts');
			break;
		case 'claude':
		case 'codex': {
			const proxy = await ensureProxy(loadConfig());
			try {
				const catalog = await fetchCatalog(proxy);
				const model = peekModel(args);
				const [env, clientArgs] = command === 'claude'
					? [claudeEnv(process.env, proxy, catalog, model), args]
					: [codexEnv(process.env, proxy, catalog, model), codexArgs(proxy, args)];
				process.on('SIGINT', () => { }); // Ctrl+C belongs to the client; we leave when it does
				process.exitCode = await runClient(command, clientArgs, env);
			} finally {
				proxy.close();
			}
			break;
		}
		case '-h':
		case '--help':
			console.log(USAGE);
			break;
		default:
			console.error(USAGE);
			process.exitCode = 2;
	}
} catch (err) {
	console.error(`claudia: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
}

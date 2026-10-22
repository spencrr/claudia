#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { createUpstreamResolver } from './github.ts';
import { createLogger } from './log.ts';
import { createServer } from './server.ts';

const config = loadConfig();
const log = createLogger(config.logLevel);
const upstream = createUpstreamResolver(config, log);

// Resolve the token and CAPI endpoint up front so misconfiguration fails fast.
await upstream.get();

const server = createServer({ config, upstream, log });
server.listen(config.port, config.host, () => {
	log.info(`claudia listening on http://${config.host}:${config.port}/v1 (auth: ${config.apiKey ? 'api key' : 'none, loopback only'})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		log.info(`${signal} received, shutting down`);
		server.close(() => process.exit(0));
		server.closeAllConnections();
	});
}

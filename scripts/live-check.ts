/**
 * Live check against the real Copilot API through an in-process claudia.
 *
 * The test suites run against fakes that encode what we believe CAPI does;
 * the upstream contract itself (which models answer where, the Responses
 * minimum output tokens, stream shapes, the MCP search endpoint) can only be
 * checked live. Run it before a release or when something smells:
 *
 *   npm run check:live
 *
 * Uses the same token resolution as `npm start` and costs about eight
 * requests, several of them to premium models.
 */
import type { AddressInfo } from 'node:net';
import { collectMessage, parseSse, textOf, type Message, type StreamEvent, type ToolUseBlock } from '../src/anthropic.ts';
import { loadConfig } from '../src/config.ts';
import { createUpstreamResolver } from '../src/github.ts';
import { createLogger } from '../src/log.ts';
import { createServer } from '../src/server.ts';
import { createWebTools } from '../src/webtools.ts';

const config = loadConfig();
const log = createLogger('warn');
const upstream = createUpstreamResolver(config, log);
const server = createServer({ config, upstream, log });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const headers = { 'content-type': 'application/json', ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}) };

let failures = 0;
async function check(name: string, run: () => Promise<string>): Promise<void> {
	const started = Date.now();
	try {
		console.log(`✔ ${name}: ${await run()} (${Date.now() - started}ms)`);
	} catch (err) {
		failures++;
		console.log(`✖ ${name}: ${err instanceof Error ? err.message : String(err)} (${Date.now() - started}ms)`);
	}
}

async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
	for await (const frame of parseSse(body)) {
		if (frame.data !== '[DONE]') { // CAPI ends Anthropic streams with an OpenAI-style terminator
			yield JSON.parse(frame.data) as StreamEvent;
		}
	}
}

// Thinking models spend the output budget on reasoning first; 64 tokens leaves Gemini one visible token.
async function messages(body: Record<string, unknown>): Promise<Message> {
	const response = await fetch(`${base}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ stream: true, max_tokens: 1024, ...body }) });
	if (!response.ok || !response.body) {
		throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	}
	return collectMessage(events(response.body), String(body.model));
}

const { login, plan, apiUrl } = await upstream.get();
console.log(`Copilot session: login=${login} plan=${plan} api=${apiUrl}\n`);

// One representative per backend family, chosen from today's catalog so the check follows it.
const { data: models } = await (await fetch(`${base}/v1/models`, { headers })).json() as { data: { id: string; supported_endpoints?: string[] }[] };
const picks = {
	messages: models.find(m => m.id.startsWith('claude-'))?.id,
	responses: models.find(m => !m.id.startsWith('claude-') && m.supported_endpoints?.includes('/responses'))?.id,
	chat: models.find(m => !m.id.startsWith('claude-') && !m.supported_endpoints?.includes('/responses'))?.id,
};
console.log(`catalog: ${models.length} models; using ${JSON.stringify(picks)}\n`);

const echoTool = { name: 'echo', description: 'Echo one word back.', input_schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } };

for (const [backend, model] of Object.entries(picks)) {
	if (!model) {
		failures++;
		console.log(`✖ ${backend}: no model in the catalog`);
		continue;
	}
	await check(`${backend} · ${model} · streamed text`, async () => {
		const message = await messages({ model, messages: [{ role: 'user', content: 'Reply with exactly: PONG' }] });
		const text = textOf(message.content).trim();
		if (!/PONG/i.test(text) || !message.stop_reason || !message.usage.output_tokens) {
			throw new Error(`got ${JSON.stringify(text)} stop_reason=${message.stop_reason} usage=${JSON.stringify(message.usage)}`);
		}
		return `"${text}" stop_reason=${message.stop_reason} output_tokens=${message.usage.output_tokens}`;
	});
	await check(`${backend} · ${model} · forced tool call`, async () => {
		const message = await messages({ model, tools: [echoTool], tool_choice: { type: 'tool', name: 'echo' }, messages: [{ role: 'user', content: 'Echo the word mango.' }] });
		const call = message.content.find((block): block is ToolUseBlock => block.type === 'tool_use');
		if (!call || message.stop_reason !== 'tool_use') {
			throw new Error(`no tool_use block; content=${JSON.stringify(message.content).slice(0, 300)} stop_reason=${message.stop_reason}`);
		}
		return `${call.name}(${JSON.stringify(call.input)})`;
	});
}

if (picks.responses) {
	// Claude Code verifies a `/model` switch with a one-token request; Responses rejects max_output_tokens < 16 unless clamped.
	await check(`responses · ${picks.responses} · one-token probe`, async () => {
		const message = await messages({ model: picks.responses, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
		return `stop_reason=${message.stop_reason}`;
	});
}

await check('GitHub MCP web_search', async () => {
	const session = await upstream.get();
	const results = await createWebTools({ apiUrl: session.apiUrl, token: session.token }).search('Node.js release schedule', {}, AbortSignal.timeout(30_000));
	if (results.length === 0) {
		throw new Error('no results');
	}
	return `${results.length} results, first ${results[0]!.url}`;
});

server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

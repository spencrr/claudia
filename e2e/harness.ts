import { spawn } from 'node:child_process';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { emptyMessage, formatSse, messageToEvents, textOf, type InputMessage, type Message, type ToolResultBlock } from '../src/anthropic.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export interface RecordedRequest {
	readonly path: string;
	readonly headers: http.IncomingHttpHeaders;
	readonly body: Record<string, unknown>;
}

export interface FakeCapi {
	readonly url: string;
	readonly requests: RecordedRequest[];
	close(): Promise<void>;
}

/** Two chat models: one Claude (verbatim passthrough), one Responses-only (translated). */
const CATALOG = [
	{ id: 'claude-mock', vendor: 'Anthropic', capabilities: { type: 'chat' } },
	{ id: 'gpt-mock', vendor: 'OpenAI', capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] },
];

type Turn = { tool: 'Read'; file_path: string } | { text: string };

/**
 * The scripted model: a tool result gets echoed back, a user message asking to
 * "Read the file `…`" gets a Read call, anything else gets "PONG". Claude Code
 * wraps prompts in <system-reminder> blocks that contain backticks of their own,
 * hence the exact phrase.
 */
function script(userTexts: readonly string[], toolResults: readonly string[]): Turn {
	if (toolResults.length > 0) {
		return { text: `The file says: ${toolResults.join('\n')}` };
	}
	const named = userTexts.map(text => /Read the file `([^`]+)`/.exec(text)?.[1]).findLast(Boolean);
	return named ? { tool: 'Read', file_path: named } : { text: 'PONG' };
}

function anthropicInputs(messages: readonly InputMessage[]): [string[], string[]] {
	const userTexts: string[] = [];
	const toolResults: string[] = [];
	for (const message of messages) {
		if (message.role !== 'user') {
			continue;
		}
		if (typeof message.content === 'string') {
			userTexts.push(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === 'text') {
				userTexts.push(String(block.text));
			} else if (block.type === 'tool_result') {
				toolResults.push(textOf((block as ToolResultBlock).content));
			}
		}
	}
	return [userTexts, toolResults];
}

type ResponsesContent = string | readonly { text?: string }[] | undefined;
interface ResponsesItem { type?: string; role?: string; content?: ResponsesContent; output?: ResponsesContent }

const flatten = (content: ResponsesContent): string => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');

function responsesInputs(input: string | readonly ResponsesItem[]): [string[], string[]] {
	if (typeof input === 'string') {
		return [[input], []];
	}
	const userTexts: string[] = [];
	const toolResults: string[] = [];
	for (const item of input) {
		if (item.type === 'function_call_output') {
			toolResults.push(flatten(item.output));
		} else if (item.role === 'user') {
			userTexts.push(flatten(item.content));
		}
	}
	return [userTexts, toolResults];
}

function anthropicMessage(model: string, turn: Turn): Message {
	const message = emptyMessage(model);
	message.content = 'tool' in turn
		? [{ type: 'tool_use', id: 'toolu_e2e', name: turn.tool, input: { file_path: turn.file_path } }]
		: [{ type: 'text', text: turn.text }];
	message.stop_reason = 'tool' in turn ? 'tool_use' : 'end_turn';
	message.usage = { input_tokens: 10, output_tokens: 5 };
	return message;
}

function responsesReply(turn: Turn): { frames: string; response: Record<string, unknown> } {
	const item = 'tool' in turn
		? { type: 'function_call', call_id: 'call_e2e', name: turn.tool, arguments: JSON.stringify({ file_path: turn.file_path }), status: 'completed' }
		: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text, annotations: [] }] };
	const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 };
	let sequence = 0;
	// Item ids differ on every event, as CAPI re-encrypts them; only output_index is stable.
	const itemId = () => `item_${sequence}`;
	const frames: string[] = [];
	const push = (type: string, data: Record<string, unknown>) => {
		frames.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
	};
	push('response.created', { response: { id: 'resp_e2e', object: 'response', status: 'in_progress', output: [] } });
	push('response.output_item.added', { output_index: 0, item: { ...item, id: itemId(), ...('arguments' in item ? { arguments: '' } : { content: [] }) } });
	if ('arguments' in item) {
		push('response.function_call_arguments.delta', { output_index: 0, item_id: itemId(), delta: item.arguments });
		push('response.function_call_arguments.done', { output_index: 0, item_id: itemId(), arguments: item.arguments });
	} else {
		const text = item.content[0]!.text;
		push('response.output_text.delta', { output_index: 0, item_id: itemId(), content_index: 0, delta: text });
		push('response.output_text.done', { output_index: 0, item_id: itemId(), content_index: 0, text });
	}
	push('response.output_item.done', { output_index: 0, item: { ...item, id: itemId() } });
	const response = { id: 'resp_e2e', object: 'response', status: 'completed', output: [{ ...item, id: itemId() }], usage };
	push('response.completed', { response });
	return { frames: frames.join(''), response };
}

/** A CAPI stand-in that plays the scripted model on both the Anthropic and the Responses surface. */
export function startFakeCapi(): Promise<FakeCapi> {
	const requests: RecordedRequest[] = [];
	const json = (res: http.ServerResponse, body: unknown) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(body));
	};
	const sse = (res: http.ServerResponse, frames: string) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.end(frames);
	};
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
			const requestPath = req.url ?? '/';
			requests.push({ path: requestPath, headers: req.headers, body });
			switch (requestPath) {
				case '/models':
					return json(res, { data: CATALOG });
				case '/v1/messages/count_tokens':
					return json(res, { input_tokens: 1 });
				case '/v1/messages': {
					const message = anthropicMessage(String(body.model), script(...anthropicInputs(body.messages as InputMessage[])));
					return body.stream ? sse(res, messageToEvents(message).map(formatSse).join('')) : json(res, message);
				}
				case '/responses': {
					const { frames, response } = responsesReply(script(...responsesInputs(body.input as string | ResponsesItem[])));
					return body.stream ? sse(res, frames) : json(res, response);
				}
				default:
					res.writeHead(404, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: `fake CAPI has no ${requestPath}` } }));
			}
		});
	});
	return new Promise(resolve => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				url: `http://127.0.0.1:${port}`,
				requests,
				close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
			});
		});
	});
}

export interface Claudia {
	readonly url: string;
	close(): void;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

/** Run the real `src/main.ts` against the fake CAPI; an explicit token skips `gh` and discovery. */
export async function startClaudia(capiUrl: string): Promise<Claudia> {
	const port = await freePort();
	const child = spawn(process.execPath, ['src/main.ts'], {
		cwd: REPO_ROOT,
		env: {
			PATH: process.env.PATH ?? '',
			SystemRoot: process.env.SystemRoot ?? '',
			GITHUB_TOKEN: 'gho_e2e',
			CLAUDIA_CAPI_URL: capiUrl,
			CLAUDIA_PORT: String(port),
			CLAUDIA_LOG_LEVEL: 'warn',
		},
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	const url = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (child.exitCode !== null) {
			throw new Error(`claudia exited with code ${child.exitCode} during startup`);
		}
		const healthy = await fetch(`${url}/health`).then(response => response.ok, () => false);
		if (healthy) {
			return { url, close: () => { child.kill(); } };
		}
		if (Date.now() > deadline) {
			child.kill();
			throw new Error('claudia did not become healthy within 15s');
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

export interface RunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run a CLI to completion, killing it (and failing) on timeout. */
export function run(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${path.basename(file)} ${args[0]} timed out after ${options.timeoutMs ?? 120_000}ms\n${stderr}`));
		}, options.timeoutMs ?? 120_000);
		child.on('error', reject);
		child.on('close', code => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** The caller's shell may carry real Anthropic/OpenAI/CLI settings; keep them out of the clients under test. */
export function cleanEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
	const inherited = Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_)/i.test(key));
	return { ...Object.fromEntries(inherited), ...overrides };
}

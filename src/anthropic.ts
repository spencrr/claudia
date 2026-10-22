/**
 * Minimal structural types for the Anthropic Messages API plus the helpers
 * every backend shares: SSE parsing, event serialization, and converting
 * between a stream of events and a complete message.
 */

import { randomUUID } from 'node:crypto';

// #region Types

export interface TextBlock { type: 'text'; text: string; [key: string]: unknown }
export interface ImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: string | ContentBlock[]; is_error?: boolean }
export interface ThinkingBlock { type: 'thinking'; thinking: string; signature?: string }
export interface ServerToolUseBlock { type: 'server_tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface WebSearchResult { type: 'web_search_result'; title: string; url: string; encrypted_content: string; page_age: string | null }
export interface WebSearchToolResultBlock {
	type: 'web_search_tool_result';
	tool_use_id: string;
	content: WebSearchResult[] | { type: 'web_search_tool_result_error'; error_code: string };
}
export interface WebFetchToolResultBlock {
	type: 'web_fetch_tool_result';
	tool_use_id: string;
	content:
	| { type: 'web_fetch_result'; url: string; retrieved_at: string; content: { type: 'document'; title: string | null; source: { type: 'text'; media_type: 'text/plain'; data: string } } }
	| { type: 'web_fetch_tool_result_error'; error_code: string };
}
/** Any block type we don't model explicitly (documents, redacted thinking, …). */
export interface OtherBlock { type: string; [key: string]: unknown }

export type ContentBlock =
	| TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock
	| ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock | OtherBlock;

export interface InputMessage { role: 'user' | 'assistant'; content: string | ContentBlock[] }

export interface CustomTool { name: string; description?: string; input_schema: Record<string, unknown>; type?: 'custom' | undefined; [key: string]: unknown }
/** Anthropic-hosted tools (`web_search_20250305`, `text_editor_*`, …) are identified by a versioned `type`. */
export interface ServerTool { type: string; name: string; max_uses?: number; [key: string]: unknown }
export type Tool = CustomTool | ServerTool;

export type ToolChoice = { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean } | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };

export interface MessagesRequest {
	model: string;
	messages: InputMessage[];
	max_tokens: number;
	system?: string | TextBlock[];
	tools?: Tool[];
	tool_choice?: ToolChoice;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
	thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' | 'disabled' };
	output_config?: { effort?: 'low' | 'medium' | 'high' | 'max' };
	[key: string]: unknown;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	server_tool_use?: { web_search_requests: number; web_fetch_requests?: number };
}

export interface Message {
	id: string;
	type: 'message';
	role: 'assistant';
	model: string;
	content: ContentBlock[];
	stop_reason: StopReason | null;
	stop_sequence: string | null;
	usage: Usage;
}

export type StreamEvent =
	| { type: 'message_start'; message: Message }
	| { type: 'content_block_start'; index: number; content_block: ContentBlock }
	| { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } | { type: 'thinking_delta'; thinking: string } }
	| { type: 'content_block_stop'; index: number }
	| { type: 'message_delta'; delta: { stop_reason: StopReason | null; stop_sequence: string | null }; usage: Usage }
	| { type: 'message_stop' }
	| { type: 'ping' }
	| { type: 'error'; error: { type: string; message: string } };

// #endregion

// #region Helpers

export function isServerTool(tool: Tool): tool is ServerTool {
	return typeof tool.type === 'string' && tool.type !== 'custom';
}

export function newMessageId(): string {
	return `msg_${randomUUID().replace(/-/g, '')}`;
}

export function emptyMessage(model: string, id = newMessageId()): Message {
	return { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

/** Flatten any `system` / tool-result content shape to plain text. */
export function textOf(content: string | ContentBlock[] | undefined): string {
	if (typeof content === 'string') {
		return content;
	}
	return (content ?? [])
		.map(block => block.type === 'text' ? String((block as TextBlock).text) : block.type === 'image' ? '[image]' : '')
		.filter(Boolean)
		.join('\n');
}

export function anthropicError(status: number, message: string): Response {
	const type = status === 400 ? 'invalid_request_error'
		: status === 401 ? 'authentication_error'
			: status === 403 ? 'permission_error'
				: status === 404 ? 'not_found_error'
					: status === 429 ? 'rate_limit_error'
						: status === 529 ? 'overloaded_error'
							: 'api_error';
	return Response.json({ type: 'error', error: { type, message } }, { status });
}

/** Serialize one event as an SSE frame in the exact shape Anthropic emits. */
export function formatSse(event: StreamEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface SseFrame { event: string | undefined; data: string }

/** Generic SSE reader: yields `{event, data}` per frame; multi-line `data:` is joined with `\n`. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
	const decoder = new TextDecoder();
	let buffer = '';
	let event: string | undefined;
	let data: string[] = [];
	const flush = (): SseFrame | undefined => {
		if (data.length === 0) {
			event = undefined;
			return undefined;
		}
		const frame = { event, data: data.join('\n') };
		event = undefined;
		data = [];
		return frame;
	};
	const consume = (line: string): SseFrame | undefined => {
		if (line === '') {
			return flush();
		}
		if (line.startsWith('event:')) {
			event = line.slice(6).trim();
		} else if (line.startsWith('data:')) {
			data.push(line.slice(5).replace(/^ /, ''));
		}
		return undefined;
	};
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let newline: number;
		while ((newline = buffer.indexOf('\n')) !== -1) {
			const frame = consume(buffer.slice(0, newline).replace(/\r$/, ''));
			buffer = buffer.slice(newline + 1);
			if (frame) {
				yield frame;
			}
		}
	}
	buffer += decoder.decode();
	if (buffer.length > 0) {
		consume(buffer.replace(/\r$/, ''));
	}
	const frame = flush();
	if (frame) {
		yield frame;
	}
}

/** Expand a complete message into the event sequence a streaming client expects. */
export function messageToEvents(message: Message): StreamEvent[] {
	const events: StreamEvent[] = [{
		type: 'message_start',
		message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } },
	}];
	message.content.forEach((block, index) => {
		if (block.type === 'text') {
			events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
			events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: (block as TextBlock).text } });
		} else if (block.type === 'tool_use') {
			const tool = block as ToolUseBlock;
			events.push({ type: 'content_block_start', index, content_block: { ...tool, input: {} } });
			events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } });
		} else {
			// server_tool_use, web_search_tool_result, … arrive whole.
			events.push({ type: 'content_block_start', index, content_block: block });
		}
		events.push({ type: 'content_block_stop', index });
	});
	events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: message.usage });
	events.push({ type: 'message_stop' });
	return events;
}

/** Fold a stream of events back into a complete message (the inverse of {@link messageToEvents}). */
export async function collectMessage(events: AsyncIterable<StreamEvent>, model: string): Promise<Message> {
	const message = emptyMessage(model);
	const partialJson = new Map<number, string>();
	for await (const event of events) {
		switch (event.type) {
			case 'message_start':
				Object.assign(message, { ...event.message, content: [...event.message.content] });
				break;
			case 'content_block_start':
				message.content[event.index] = structuredClone(event.content_block);
				break;
			case 'content_block_delta': {
				const block = message.content[event.index];
				if (!block) {
					break;
				}
				if (event.delta.type === 'text_delta') {
					(block as TextBlock).text += event.delta.text;
				} else if (event.delta.type === 'input_json_delta') {
					partialJson.set(event.index, (partialJson.get(event.index) ?? '') + event.delta.partial_json);
				} else if (event.delta.type === 'thinking_delta') {
					(block as ThinkingBlock).thinking += event.delta.thinking;
				}
				break;
			}
			case 'content_block_stop': {
				const json = partialJson.get(event.index);
				if (json !== undefined) {
					(message.content[event.index] as ToolUseBlock).input = parseJsonObject(json);
				}
				break;
			}
			case 'message_delta':
				message.stop_reason = event.delta.stop_reason;
				message.stop_sequence = event.delta.stop_sequence;
				message.usage = { ...message.usage, ...event.usage };
				break;
			case 'error':
				throw new Error(`${event.error.type}: ${event.error.message}`);
			default:
				break;
		}
	}
	return message;
}

export function parseJsonObject(text: string): Record<string, unknown> {
	if (!text.trim()) {
		return {};
	}
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
	} catch {
		return { _raw: text };
	}
}

// #endregion

/**
 * Anthropic Messages ⇄ OpenAI translation. Requests are converted whole;
 * responses are translated as streams of Anthropic events (non-streaming
 * callers fold them with `collectMessage`). Two targets, because CAPI serves
 * some vendors only on Chat Completions and others only on Responses.
 */

import { randomUUID } from 'node:crypto';
import {
	emptyMessage,
	isServerTool,
	textOf,
	type ContentBlock,
	type CustomTool,
	type ImageBlock,
	type MessagesRequest,
	type SseFrame,
	type StopReason,
	type StreamEvent,
	type TextBlock,
	type ToolResultBlock,
	type ToolUseBlock,
	type Usage,
} from './anthropic.ts';

// #region Shared request pieces

function systemText(req: MessagesRequest): string | undefined {
	const text = textOf(req.system);
	return text.length > 0 ? text : undefined;
}

/** Hosted Anthropic tools have no OpenAI equivalent; only JSON-schema tools cross over. */
function customTools(req: MessagesRequest): CustomTool[] {
	return (req.tools ?? []).filter((tool): tool is CustomTool => !isServerTool(tool));
}

function parameters(tool: CustomTool): Record<string, unknown> {
	const { $schema: _schema, ...schema } = tool.input_schema;
	return Object.keys(schema).length > 0 ? schema : { type: 'object', properties: {} };
}

function imageUrl(block: ImageBlock): string {
	return block.source.type === 'url' ? block.source.url : `data:${block.source.media_type};base64,${block.source.data}`;
}

/** History blocks produced by hosted tools (ours or Anthropic's) become plain text for other vendors. */
function describeBlock(block: ContentBlock): string | undefined {
	switch (block.type) {
		case 'server_tool_use':
			return `[${(block as { name: string }).name}: ${JSON.stringify((block as { input: unknown }).input)}]`;
		case 'web_search_tool_result': {
			const content = (block as { content: unknown }).content;
			return Array.isArray(content)
				? content.map((r: { title?: string; url?: string }) => `- ${r.title ?? ''} ${r.url ?? ''}`.trim()).join('\n')
				: '[web search failed]';
		}
		case 'web_fetch_tool_result': {
			const content = (block as { content: { content?: { source?: { data?: string } } } }).content;
			return content.content?.source?.data ?? '[web fetch failed]';
		}
		case 'document': {
			const source = (block as { source?: { type?: string; data?: string } }).source;
			return source?.type === 'text' && source.data ? source.data : '[document omitted]';
		}
		default:
			return undefined;
	}
}

function toolChoiceFor(req: MessagesRequest, named: (name: string) => unknown): { tool_choice?: unknown; parallel_tool_calls?: boolean } {
	const out: { tool_choice?: unknown; parallel_tool_calls?: boolean } = {};
	const choice = req.tool_choice;
	if (choice) {
		out.tool_choice = choice.type === 'any' ? 'required' : choice.type === 'tool' ? named(choice.name) : choice.type;
		if (choice.disable_parallel_tool_use) {
			out.parallel_tool_calls = false;
		}
	}
	return out;
}

function reasoningEffort(req: MessagesRequest): 'low' | 'medium' | 'high' | undefined {
	const effort = req.output_config?.effort;
	if (effort) {
		return effort === 'max' ? 'high' : effort;
	}
	if (req.thinking?.type === 'enabled') {
		const budget = req.thinking.budget_tokens;
		return budget < 4096 ? 'low' : budget < 16384 ? 'medium' : 'high';
	}
	return undefined;
}

function finishToStopReason(finish: string | undefined, sawToolCall: boolean): StopReason {
	if (finish === 'length') {
		return 'max_tokens';
	}
	if (finish === 'tool_calls' || finish === 'function_call' || sawToolCall) {
		return 'tool_use';
	}
	return 'end_turn';
}

// #endregion

// #region Chat Completions

export function toChatRequest(req: MessagesRequest): Record<string, unknown> {
	const messages: unknown[] = [];
	const system = systemText(req);
	if (system) {
		messages.push({ role: 'system', content: system });
	}
	for (const message of req.messages) {
		if (typeof message.content === 'string') {
			messages.push({ role: message.role, content: message.content });
			continue;
		}
		if (message.role === 'assistant') {
			const text: string[] = [];
			const toolCalls: unknown[] = [];
			for (const block of message.content) {
				if (block.type === 'text') {
					text.push((block as TextBlock).text);
				} else if (block.type === 'tool_use') {
					const tool = block as ToolUseBlock;
					toolCalls.push({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } });
				} else {
					const described = describeBlock(block);
					if (described) {
						text.push(described);
					}
				}
			}
			if (text.length > 0 || toolCalls.length > 0) {
				messages.push({ role: 'assistant', content: text.join('\n') || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
			}
		} else {
			const parts: unknown[] = [];
			for (const block of message.content) {
				if (block.type === 'tool_result') {
					const result = block as ToolResultBlock;
					messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: textOf(result.content) || (result.is_error ? 'error' : '(no output)') });
				} else if (block.type === 'text') {
					parts.push({ type: 'text', text: (block as TextBlock).text });
				} else if (block.type === 'image') {
					parts.push({ type: 'image_url', image_url: { url: imageUrl(block as ImageBlock) } });
				} else {
					const described = describeBlock(block);
					if (described) {
						parts.push({ type: 'text', text: described });
					}
				}
			}
			if (parts.length > 0) {
				messages.push({ role: 'user', content: parts });
			}
		}
	}

	const tools = customTools(req).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: parameters(tool) } }));
	return {
		model: req.model,
		messages,
		...(tools.length > 0 ? { tools, ...toolChoiceFor(req, name => ({ type: 'function', function: { name } })) } : {}),
		max_tokens: req.max_tokens,
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
		...(req.stop_sequences?.length ? { stop: req.stop_sequences } : {}),
		stream: true,
		stream_options: { include_usage: true },
	};
}

interface ChatChunk {
	id?: string;
	error?: { message?: string };
	usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
	choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
}

export async function* chatToEvents(frames: AsyncIterable<SseFrame>, model: string): AsyncGenerator<StreamEvent> {
	let started = false;
	let nextIndex = 0;
	let open: { index: number; kind: 'text' | 'tool' } | undefined;
	const toolBlocks = new Map<number, number>();
	let finish: string | undefined;
	let usage: Usage = { input_tokens: 0, output_tokens: 0 };

	const close = function* (): Generator<StreamEvent> {
		if (open) {
			yield { type: 'content_block_stop', index: open.index };
			open = undefined;
		}
	};

	for await (const frame of frames) {
		if (frame.data === '[DONE]') {
			break;
		}
		let chunk: ChatChunk;
		try {
			chunk = JSON.parse(frame.data) as ChatChunk;
		} catch {
			continue;
		}
		if (chunk.error) {
			yield { type: 'error', error: { type: 'api_error', message: chunk.error.message ?? JSON.stringify(chunk.error) } };
			return;
		}
		if (!started) {
			started = true;
			yield { type: 'message_start', message: emptyMessage(model, chunk.id ? `msg_${chunk.id}` : undefined) };
		}
		if (chunk.usage) {
			usage = {
				input_tokens: chunk.usage.prompt_tokens ?? 0,
				output_tokens: chunk.usage.completion_tokens ?? 0,
				cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
			};
		}
		const choice = chunk.choices?.[0];
		if (!choice) {
			continue;
		}
		const delta = choice.delta ?? {};
		if (typeof delta.content === 'string' && delta.content.length > 0) {
			if (open?.kind !== 'text') {
				yield* close();
				open = { index: nextIndex++, kind: 'text' };
				yield { type: 'content_block_start', index: open.index, content_block: { type: 'text', text: '' } };
			}
			yield { type: 'content_block_delta', index: open.index, delta: { type: 'text_delta', text: delta.content } };
		}
		for (const call of delta.tool_calls ?? []) {
			const key = call.index ?? 0;
			let index = toolBlocks.get(key);
			if (index === undefined) {
				yield* close();
				index = nextIndex++;
				toolBlocks.set(key, index);
				open = { index, kind: 'tool' };
				yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id ?? `call_${randomUUID()}`, name: call.function?.name ?? '', input: {} } };
			}
			if (call.function?.arguments) {
				yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } };
			}
		}
		if (choice.finish_reason) {
			finish = choice.finish_reason;
		}
	}

	if (!started) {
		yield { type: 'message_start', message: emptyMessage(model) };
	}
	yield* close();
	yield { type: 'message_delta', delta: { stop_reason: finishToStopReason(finish, toolBlocks.size > 0), stop_sequence: null }, usage };
	yield { type: 'message_stop' };
}

// #endregion

// #region Responses

export function toResponsesRequest(req: MessagesRequest): Record<string, unknown> {
	const input: unknown[] = [];
	for (const message of req.messages) {
		if (typeof message.content === 'string') {
			input.push({ role: message.role, content: message.content });
			continue;
		}
		if (message.role === 'assistant') {
			for (const block of message.content) {
				if (block.type === 'text') {
					input.push({ role: 'assistant', content: [{ type: 'output_text', text: (block as TextBlock).text }] });
				} else if (block.type === 'tool_use') {
					const tool = block as ToolUseBlock;
					input.push({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: JSON.stringify(tool.input) });
				} else {
					const described = describeBlock(block);
					if (described) {
						input.push({ role: 'assistant', content: [{ type: 'output_text', text: described }] });
					}
				}
			}
		} else {
			const parts: unknown[] = [];
			for (const block of message.content) {
				if (block.type === 'tool_result') {
					const result = block as ToolResultBlock;
					input.push({ type: 'function_call_output', call_id: result.tool_use_id, output: textOf(result.content) || (result.is_error ? 'error' : '(no output)') });
				} else if (block.type === 'text') {
					parts.push({ type: 'input_text', text: (block as TextBlock).text });
				} else if (block.type === 'image') {
					parts.push({ type: 'input_image', image_url: imageUrl(block as ImageBlock) });
				} else {
					const described = describeBlock(block);
					if (described) {
						parts.push({ type: 'input_text', text: described });
					}
				}
			}
			if (parts.length > 0) {
				input.push({ role: 'user', content: parts });
			}
		}
	}

	const tools = customTools(req).map(tool => ({ type: 'function', name: tool.name, description: tool.description ?? '', parameters: parameters(tool) }));
	const effort = reasoningEffort(req);
	const system = systemText(req);
	return {
		model: req.model,
		...(system ? { instructions: system } : {}),
		input,
		...(tools.length > 0 ? { tools, ...toolChoiceFor(req, name => ({ type: 'function', name })) } : {}),
		max_output_tokens: req.max_tokens,
		...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
		...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
		...(effort ? { reasoning: { effort } } : {}),
		stream: true,
		store: false,
	};
}

interface ResponsesEvent {
	type: string;
	/** Stable per output item. (`item_id` is not: CAPI re-encrypts it on every event.) */
	output_index?: number;
	delta?: string;
	item?: { id?: string; type?: string; call_id?: string; name?: string };
	response?: {
		id?: string;
		status?: string;
		incomplete_details?: { reason?: string };
		usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
		error?: { code?: string; message?: string };
	};
	error?: { type?: string; code?: string; message?: string };
	message?: string;
}

export async function* responsesToEvents(frames: AsyncIterable<SseFrame>, model: string): AsyncGenerator<StreamEvent> {
	let started = false;
	let nextIndex = 0;
	const blocks = new Map<number, { index: number; closed: boolean }>();
	let sawToolCall = false;
	let stopReason: StopReason = 'end_turn';
	let usage: Usage = { input_tokens: 0, output_tokens: 0 };

	const start = function* (id?: string): Generator<StreamEvent> {
		if (!started) {
			started = true;
			yield { type: 'message_start', message: emptyMessage(model, id ? `msg_${id}` : undefined) };
		}
	};

	for await (const frame of frames) {
		let event: ResponsesEvent;
		try {
			event = JSON.parse(frame.data) as ResponsesEvent;
		} catch {
			continue;
		}
		const key = event.output_index ?? -1;
		switch (event.type) {
			case 'response.created':
				yield* start(event.response?.id);
				break;
			case 'response.output_item.added': {
				yield* start();
				const item = event.item;
				if (item?.type === 'function_call') {
					sawToolCall = true;
					const index = nextIndex++;
					blocks.set(key, { index, closed: false });
					yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: item.call_id ?? item.id ?? `call_${randomUUID()}`, name: item.name ?? '', input: {} } };
				}
				break;
			}
			case 'response.output_text.delta': {
				yield* start();
				let block = blocks.get(key);
				if (!block) {
					block = { index: nextIndex++, closed: false };
					blocks.set(key, block);
					yield { type: 'content_block_start', index: block.index, content_block: { type: 'text', text: '' } };
				}
				yield { type: 'content_block_delta', index: block.index, delta: { type: 'text_delta', text: event.delta ?? '' } };
				break;
			}
			case 'response.function_call_arguments.delta': {
				const block = blocks.get(key);
				if (block && event.delta) {
					yield { type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: event.delta } };
				}
				break;
			}
			case 'response.output_item.done': {
				const block = blocks.get(key);
				if (block && !block.closed) {
					block.closed = true;
					yield { type: 'content_block_stop', index: block.index };
				}
				break;
			}
			case 'response.completed':
			case 'response.incomplete':
			case 'response.failed': {
				const response = event.response ?? {};
				if (response.usage) {
					usage = {
						input_tokens: response.usage.input_tokens ?? 0,
						output_tokens: response.usage.output_tokens ?? 0,
						cache_read_input_tokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
					};
				}
				if (event.type === 'response.incomplete' && response.incomplete_details?.reason === 'max_output_tokens') {
					stopReason = 'max_tokens';
				}
				if (event.type === 'response.failed') {
					yield* start();
					yield { type: 'error', error: { type: 'api_error', message: response.error?.message ?? 'response failed' } };
					return;
				}
				break;
			}
			case 'error':
				yield* start();
				yield { type: 'error', error: { type: event.error?.type ?? 'api_error', message: event.error?.message ?? event.message ?? 'unknown error' } };
				return;
			default:
				break;
		}
	}

	yield* start();
	for (const block of [...blocks.values()].sort((a, b) => a.index - b.index)) {
		if (!block.closed) {
			yield { type: 'content_block_stop', index: block.index };
		}
	}
	if (stopReason === 'end_turn' && sawToolCall) {
		stopReason = 'tool_use';
	}
	yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage };
	yield { type: 'message_stop' };
}

// #endregion

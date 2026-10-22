import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { collectMessage, formatSse, messageToEvents, parseSse, type Message } from '../src/anthropic.ts';

function stream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + chunkSize));
			offset += chunkSize;
		},
	});
}

async function all<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) {
		out.push(item);
	}
	return out;
}

describe('parseSse', () => {
	test('reassembles frames across arbitrary chunk boundaries', async () => {
		const frames = await all(parseSse(stream('event: a\ndata: {"x":1}\n\n: comment\ndata: line1\ndata: line2\n\nevent: b\r\ndata: last')));
		assert.deepEqual(frames, [
			{ event: 'a', data: '{"x":1}' },
			{ event: undefined, data: 'line1\nline2' },
			{ event: 'b', data: 'last' },
		]);
	});
});

describe('messageToEvents / collectMessage', () => {
	const message: Message = {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model: 'm',
		content: [
			{ type: 'text', text: 'Let me look.' },
			{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
			{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'q' } },
			{ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 't', url: 'https://x', encrypted_content: '', page_age: null }] },
		],
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
	};

	test('round-trips a message through the event stream', async () => {
		const events = messageToEvents(message);
		assert.equal(events[0]?.type, 'message_start');
		assert.equal(events.at(-1)?.type, 'message_stop');
		const rebuilt = await collectMessage((async function* () { yield* events; })(), 'm');
		assert.deepEqual(rebuilt, message);
	});

	test('formatSse writes Anthropic-style frames', () => {
		assert.equal(formatSse({ type: 'message_stop' }), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
	});

	test('collectMessage tolerates unparsable tool input and surfaces stream errors', async () => {
		const rebuilt = await collectMessage((async function* () {
			yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'f', input: {} } } as const;
			yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"broken' } } as const;
			yield { type: 'content_block_stop', index: 0 } as const;
		})(), 'm');
		assert.deepEqual((rebuilt.content[0] as { input: unknown }).input, { _raw: '{"broken' });

		await assert.rejects(
			collectMessage((async function* () { yield { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } as const; })(), 'm'),
			/overloaded_error: busy/,
		);
	});
});

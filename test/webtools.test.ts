import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeEntities, defaultWebTools, htmlToText, parseRss } from '../src/webtools.ts';

describe('parseRss', () => {
	test('extracts title, link and description from Bing RSS items', () => {
		const xml = `<?xml version="1.0"?><rss><channel><title>Bing</title>
			<item><title>Node.js &amp; Releases</title><link>https://nodejs.org/en/about/previous-releases</link><description>Major &lt;b&gt;Node.js&lt;/b&gt; versions &#8230;</description></item>
			<item><title><![CDATA[Second <result>]]></title><link>https://example.com/x?a=1&amp;b=2</link><description></description></item>
		</channel></rss>`;
		assert.deepEqual(parseRss(xml), [
			{ title: 'Node.js & Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Major Node.js versions …' },
			{ title: 'Second', url: 'https://example.com/x?a=1&b=2', snippet: '' },
		]);
	});
});

describe('htmlToText', () => {
	test('drops scripts/styles, keeps block structure and the title', () => {
		const page = htmlToText('<html><head><title>Hi &amp; bye</title><style>p{}</style></head><body><script>x()</script><h1>Head</h1><p>One<br>two</p><ul><li>a</li><li>b</li></ul></body></html>');
		assert.equal(page.title, 'Hi & bye');
		assert.equal(page.text, 'Head\nOne\ntwo\na\nb');
	});
});

describe('decodeEntities', () => {
	test('handles named, decimal and hex entities', () => {
		assert.equal(decodeEntities('&lt;a&gt; &#65;&#x42; &nbsp;&unknown;'), '<a> AB  &unknown;');
	});
});

describe('defaultWebTools.fetchPage', () => {
	test('refuses non-http and dotless hosts without touching the network', async () => {
		await assert.rejects(defaultWebTools.fetchPage('file:///etc/passwd'), /only public http\(s\) URLs/);
		await assert.rejects(defaultWebTools.fetchPage('http://localhost:8080/'), /only public http\(s\) URLs/);
	});
});

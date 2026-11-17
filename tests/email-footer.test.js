import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailContent } from '../scripts/email-footer.js';

test('email without settings preserves the existing plain-text payload', () => {
  const text = 'Original digest\n第二行\n';
  assert.deepEqual(buildEmailContent(text), { text });
  assert.deepEqual(buildEmailContent(text, ''), { text });
});

test('email provides a settings link in plain text and an HTML button', () => {
  const url = 'https://digest.example.com/settings?token=example&view=daily';
  const content = buildEmailContent('Daily digest', url);
  assert.ok(content.text.startsWith('Daily digest\n'));
  assert.ok(content.text.includes(`调整发送时间：${url}`));
  assert.match(content.html, /<a href="https:\/\/digest\.example\.com\/settings\?token=example&amp;view=daily"/);
  assert.match(content.html, />调整发送时间<\/a>/);
});

test('digest HTML, attributes, and entities are escaped rather than executed', () => {
  const text = '<script>alert("x")</script>\n<img src=x onerror=alert(1)> & \'quoted\'';
  const content = buildEmailContent(text, 'https://digest.example.com/settings?token=example');
  assert.ok(content.text.startsWith(text));
  assert.ok(!content.html.includes('<script>'));
  assert.ok(!content.html.includes('<img'));
  assert.ok(content.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>'));
  assert.ok(content.html.includes('&amp; &#39;quoted&#39;'));
});

test('settings links cannot downgrade HTTPS or introduce a script URL', () => {
  for (const url of ['http://digest.example.com/settings', 'javascript:alert(1)', 'https://user:pass@example.com/settings']) {
    assert.throws(() => buildEmailContent('Digest', url), /HTTPS without embedded credentials/);
  }
});

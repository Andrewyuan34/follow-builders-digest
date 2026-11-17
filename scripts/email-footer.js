const SETTINGS_LABEL = '调整发送时间';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

// Keep the original plain-text delivery when self-service settings are disabled.
export function buildEmailContent(text, settingsUrl) {
  if (!settingsUrl) return { text };

  const url = new URL(settingsUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Email settings URL must use HTTPS without embedded credentials');
  }

  const safeUrl = escapeHtml(url.href);
  const safeText = escapeHtml(text).replace(/\r?\n/g, '<br>\n');
  return {
    text: `${text}\n\n────────────────────\n${SETTINGS_LABEL}：${url.href}\n打开设置页，选择时间并保存即可。`,
    html: `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#f5f6f8;color:#20242c;font-family:Arial,'Microsoft YaHei',sans-serif">
  <div style="max-width:680px;margin:0 auto;padding:32px 24px;background:#ffffff">
    <div style="font-size:16px;line-height:1.75;overflow-wrap:anywhere">${safeText}</div>
    <div style="margin-top:32px;border-top:1px solid #e4e7ec;padding-top:24px">
      <a href="${safeUrl}" style="display:inline-block;background:#234d7a;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:bold">${SETTINGS_LABEL}</a>
      <p style="margin:12px 0 0;color:#667085;font-size:13px;line-height:1.6">打开设置页，选择时间并保存即可。</p>
    </div>
  </div>
</body>
</html>`
  };
}

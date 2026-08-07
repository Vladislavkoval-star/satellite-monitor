import { requireEnv } from './config.mjs';

const TELEGRAM_API = 'https://api.telegram.org';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Send one HTML message to the configured Telegram chat.
 * Returns true on success. Never throws — a failed alert must not fail the run,
 * but it is logged so the workflow output shows it.
 */
export async function sendTelegram(html) {
  let token;
  let chatId;
  try {
    token = requireEnv('TELEGRAM_BOT_TOKEN');
    chatId = requireEnv('TELEGRAM_CHAT_ID');
  } catch (err) {
    console.error(`[notify] ${err.message}`);
    return false;
  }

  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // Deliberately does not log the response body — it echoes the token path.
      console.error(`[notify] Telegram returned HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[notify] send failed: ${err.name}`);
    return false;
  }
}

/** Build the alert body for a batch of newly-down hosts. */
export function formatDownAlert(events) {
  const lines = ['🔴 <b>SITE DOWN</b>', ''];
  for (const e of events) {
    lines.push(`<b>${escapeHtml(e.host)}</b>`);
    lines.push(`  ${escapeHtml(e.type)} · трафик ${e.traffic === 'high' ? 'высокий' : 'низкий'}`);
    lines.push(`  ${escapeHtml(e.reason)}`);
    lines.push(`  <a href="https://${e.host}/">открыть</a>`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Build the alert body for hosts that came back. */
export function formatRecoveryAlert(events) {
  const lines = ['🟢 <b>SITE RECOVERED</b>', ''];
  for (const e of events) {
    lines.push(`<b>${escapeHtml(e.host)}</b> — лежал ${escapeHtml(e.downFor)}`);
  }
  return lines.join('\n').trim();
}

/** Build the alert body for TLS certificates nearing expiry. */
export function formatSslAlert(events) {
  const lines = ['🟠 <b>SSL EXPIRING</b>', ''];
  for (const e of events) {
    lines.push(`<b>${escapeHtml(e.host)}</b> — ${e.daysLeft} дн. (до ${escapeHtml(e.validTo)})`);
  }
  return lines.join('\n').trim();
}

/** Build the alert body for pages that respond but do not render. */
export function formatRenderAlert(events) {
  const lines = ['🟡 <b>RENDER BROKEN</b> (отдаёт 200, но страница нерабочая)', ''];
  for (const e of events) {
    lines.push(`<b>${escapeHtml(e.host)}</b>`);
    lines.push(`  ${escapeHtml(e.reason)}`);
    lines.push(`  <a href="https://${e.host}/">открыть</a>`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export { escapeHtml };

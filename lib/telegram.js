// Minimal Telegram Bot API client — mirrors third-serve-agent/lib/telegram.js
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env

async function call(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

export function sendMessage(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID not set");
  return call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

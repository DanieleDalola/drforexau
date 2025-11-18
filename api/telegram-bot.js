// api/telegram-bot.js
// Serverless function Vercel (Node.js – CommonJS)

// Helper per fare logging nei Runtime Logs di Vercel
function log(...args) {
  console.log('[TG]', ...args);
}

// Parsing di un testo tipo:
// "SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7"
// "BUY XAUUSD 4040 SL 4030 TP 4060"
// "SELL STOP XAUUSD 3990 SL 4000 TP 3960"
function parseSignal(text) {
  if (!text) return null;

  // prendiamo solo la prima riga con un pattern riconoscibile
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const re = /^(BUY|SELL)(?:\s*[_\s](LIMIT|STOP))?\s+([A-Z/]+)\s+(\d+(?:\.\d+)?)(?:\s+SL\s+(\d+(?:\.\d+)?))?(?:\s+TP\s+(\d+(?:\.\d+)?))?/i;

    const m = trimmed.match(re);
    if (!m) continue;

    const side = m[1].toUpperCase();
    const orderKind = (m[2] || 'MARKET').toUpperCase();  // LIMIT | STOP | MARKET
    const symbol = m[3].toUpperCase();
    const entry = parseFloat(m[4]);
    const sl = m[5] ? parseFloat(m[5]) : null;
    const tp = m[6] ? parseFloat(m[6]) : null;

    if (!symbol || Number.isNaN(entry)) continue;

    // status: pending se LIMIT/STOP, active se MARKET
    const status =
      orderKind === 'LIMIT' || orderKind === 'STOP' ? 'pending' : 'active';

    return {
      symbol,
      side,
      order_kind: orderKind, // LIMIT / STOP / MARKET
      entry,
      sl,
      tp,
      status,
    };
  }

  return null;
}

// Salva su Supabase via REST API
async function saveSignalToSupabase(signal) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !serviceKey) {
    log('Manca SUPABASE_URL o SUPABASE_SERVICE_ROLE');
    return null;
  }

  const endpoint = `${url}/rest/v1/signals`;

  const payload = {
    symbol: signal.symbol,
    side: signal.side,
    order_kind: signal.order_kind,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    status: signal.status,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  log('Supabase response', res.status, text);

  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }

  try {
    const json = JSON.parse(text);
    return Array.isArray(json) ? json[0] : json;
  } catch {
    return null;
  }
}

// Manda un messaggio via Telegram API
async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log('Manca TELEGRAM_BOT_TOKEN');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });

  const body = await res.text();
  log('sendMessage', res.status, body);
}

// Handler principale (Vercel Node.js function)
module.exports = async (req, res) => {
  // Telegram invia POST; GET lo usiamo solo per test rapido
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, info: 'DR-Forexau Telegram webhook live' });
  }

  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch (e) {
      log('Errore parse body string', e.message);
      return res.status(200).json({ ok: true });
    }
  }

  log('Update ricevuto:', JSON.stringify(update));

  const msg =
    update.message ||
    update.channel_post ||
    update.edited_message ||
    update.edited_channel_post;

  if (!msg) {
    log('Nessun message/channel_post nel body');
    return res.status(200).json({ ok: true });
  }

  const chatId = msg.chat && msg.chat.id;
  const text = msg.text || '';

  if (!chatId) {
    log('Nessun chatId');
    return res.status(200).json({ ok: true });
  }

  // Comandi base
  if (text.startsWith('/start')) {
    await sendTelegramMessage(
      chatId,
      '🤖 *DR-Forexau Signals Bot*\nBot collegato correttamente.\nInoltra qui un segnale tipo:\n`SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7`'
    );
    return res.status(200).json({ ok: true });
  }

  if (text.startsWith('/test')) {
    await sendTelegramMessage(chatId, '✅ Test ok, webhook funzionante.');
    return res.status(200).json({ ok: true });
  }

  // Prova a parsare il segnale
  const signal = parseSignal(text);
  if (!signal) {
    log('Nessun segnale riconosciuto in questo messaggio.');
    // Non è obbligatorio rispondere ogni volta
    return res.status(200).json({ ok: true });
  }

  try {
    const saved = await saveSignalToSupabase(signal);
    await sendTelegramMessage(
      chatId,
      `✅ Segnale registrato:\n` +
        `*${signal.side} ${signal.order_kind}* ${signal.symbol}\n` +
        `Entry: \`${signal.entry}\`\n` +
        `SL: \`${signal.sl ?? '—'}\` · TP: \`${signal.tp ?? '—'}\``
    );
    log('Segnale salvato', saved);
  } catch (e) {
    log('Errore salvataggio segnale', e.message);
    await sendTelegramMessage(
      chatId,
      '⚠️ Errore nel salvataggio del segnale su Supabase.'
    );
  }

  return res.status(200).json({ ok: true });
};

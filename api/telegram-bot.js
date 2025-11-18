// api/telegram-bot.js
import { createClient } from '@supabase/supabase-js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// normalizza numeri tipo "4042,7" -> 4042.7
function toNumber(str) {
  if (!str) return null;
  return Number(String(str).replace(',', '.'));
}

// 🔍 PARSING SEGNALI
function parseSignal(text) {
  if (!text) return null;

  const raw = text.trim();
  const upper = raw.toUpperCase().replace(/,/g, '.');

  // 1) Formato compatto su una riga
  //   Esempio:  SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7
  let m = upper.match(
    /\b(BUY|SELL)\s*_?(LIMIT|STOP)?\s+([A-Z0-9:\/]+)\s+([0-9.]+)\s+SL[:\s]*([0-9.]+)\s+TP[:\s]*([0-9.]+)/
  );
  if (m) {
    const [, side, kindRaw, symbolRaw, entryRaw, slRaw, tpRaw] = m;
    return {
      side: side,
      order_kind: (kindRaw || 'MARKET').toUpperCase(),
      symbol: symbolRaw.replace(':', '').toUpperCase(),
      entry: toNumber(entryRaw),
      sl: toNumber(slRaw),
      tp: toNumber(tpRaw),
      raw,
    };
  }

  // 2) Formato multi-linea in stile:
  //   Buy limit xauusd
  //   Entry4005
  //   SL4995
  //   TP 4035
  const sideMatch = upper.match(/\b(BUY|SELL)\b/);
  if (!sideMatch) return null;

  const kindMatch = upper.match(/\b(LIMIT|STOP)\b/);
  let symbolMatch = upper.match(/\b(XAUUSD|XAU\/USD|XAUUSDT|XAGUSD|EURUSD|BTCUSD|BTCUSDT)\b/);

  const entryMatch = upper.match(/ENTRY\s*:?\s*([0-9.]+)/);
  const slMatch = upper.match(/\bSL\s*:?\s*([0-9.]+)/);
  const tpMatch = upper.match(/\bTP\s*:?\s*([0-9.]+)/);

  if (!entryMatch || !slMatch || !tpMatch) {
    // non abbiamo abbastanza info
    return null;
  }

  const side = sideMatch[1];
  const kind = (kindMatch?.[1] || 'MARKET').toUpperCase();

  // se non trova il simbolo ma parliamo sempre di oro, di default XAUUSD
  const symbol = symbolMatch ? symbolMatch[1].replace('/', '').toUpperCase() : 'XAUUSD';

  return {
    side,
    order_kind: kind,
    symbol,
    entry: toNumber(entryMatch[1]),
    sl: toNumber(slMatch[1]),
    tp: toNumber(tpMatch[1]),
    raw,
  };
}

// invia risposta al gruppo / chat
async function replyToTelegram(chatId, replyToMessageId, text) {
  if (!TELEGRAM_BOT_TOKEN) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      reply_to_message_id: replyToMessageId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'Telegram webhook live' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const update = req.body;

    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true, ignored: 'no text message' });
    }

    const chatId = msg.chat.id;
    const messageId = msg.message_id;
    const text = msg.text;

    const parsed = parseSignal(text);

    if (!parsed) {
      // messaggio non riconosciuto come segnale → ignoro in silenzio
      return res.status(200).json({ ok: true, ignored: 'no signal pattern' });
    }

    const { side, order_kind, symbol, entry, sl, tp, raw } = parsed;

    // salva su Supabase
    const { error } = await supabase.from('signals').insert([
      {
        symbol,
        side,
        order_kind,
        entry,
        sl,
        tp,
        raw_text: raw,
      },
    ]);

    if (error) {
      await replyToTelegram(
        chatId,
        messageId,
        `⚠️ Errore nel salvataggio del segnale: <code>${error.message}</code>`
      );
      return res.status(200).json({ ok: false, error: error.message });
    }

    const niceKind =
      order_kind === 'LIMIT' || order_kind === 'STOP'
        ? `${side} ${order_kind}`
        : side;

    await replyToTelegram(
      chatId,
      messageId,
      [
        '✅ Segnale registrato:',
        `<b>${niceKind} ${symbol}</b>`,
        `Entry: <b>${entry}</b>`,
        `SL: <b>${sl}</b> · TP: <b>${tp}</b>`,
      ].join('\n')
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Telegram webhook error', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}


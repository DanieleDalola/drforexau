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
  // tolgo CRLF, virgole e underscore
  const upper = raw
    .toUpperCase()
    .replace(/\r\n/g, '\n')
    .replace(/_/g, ' ')
    .replace(/,/g, '.');

  // 1) Formato compatto su una riga
  //    es: SELL_LIMIT XAUUSD 4041 SL 4050 TP 4005
  const m1 = upper.match(
    /\b(BUY|SELL)\s+(LIMIT|STOP)?\s*([A-Z0-9:\/]+)\s+([0-9.]+)\s+SL[:\s]*([0-9.]+)\s+TP[:\s]*([0-9.]+)/
  );

  if (m1) {
    const [, side, kindRaw, symbolRaw, entryRaw, slRaw, tpRaw] = m1;
    return {
      side,
      order_kind: (kindRaw || 'MARKET').toUpperCase(),
      symbol: symbolRaw.replace(':', '').toUpperCase(),
      entry: toNumber(entryRaw),
      sl: toNumber(slRaw),
      tp: toNumber(tpRaw),
      raw,
    };
  }

  // 2) Formato multi-linea:
  //   Buy limit xauusd
  //   Entry4005
  //   SL4995
  //   TP 4035
  const m2 = upper.match(
    /\b(BUY|SELL)\s+(LIMIT|STOP)?[\s\S]*?(XAUUSD|XAGUSD|EURUSD|BTCUSD|BTCUSDT)?[\s\S]*?ENTRY\D*([0-9.]+)[\s\S]*?SL\D*([0-9.]+)[\s\S]*?TP\D*([0-9.]+)/
  );

  if (m2) {
    const [, side, kindRaw, symbolRaw, entryRaw, slRaw, tpRaw] = m2;
    const symbol = (symbolRaw || 'XAUUSD').replace('/', '').toUpperCase();

    return {
      side,
      order_kind: (kindRaw || 'MARKET').toUpperCase(),
      symbol,
      entry: toNumber(entryRaw),
      sl: toNumber(slRaw),
      tp: toNumber(tpRaw),
      raw,
    };
  }

  return null;
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
      // 👇 così vediamo SUBITO se il parsing fallisce
      const safe = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await replyToTelegram(
        chatId,
        messageId,
        `⚠️ Non ho riconosciuto questo come segnale.\n\n<code>${safe}</code>`
      );
      return res.status(200).json({ ok: true, ignored: 'no signal pattern' });
    }

    const { side, order_kind, symbol, entry, sl, tp, raw } = parsed;

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




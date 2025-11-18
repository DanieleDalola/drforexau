// ================================
// TELEGRAM BOT WEBHOOK (VERCEL)
// ================================

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true });
    }

    const update = req.body;

    // Messaggio arrivato su Telegram
    if (!update.message || !update.message.text) {
      return res.status(200).send("no-message");
    }

    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    // ==========================
    // 1) Comando: /start
    // ==========================
    if (text === "/start") {
      await sendMessage(chatId,
        "👋 Benvenuto! Invia un segnale nel formato:\n\n" +
        "`BUY XAUUSD 3290 SL 3280 TP 3305`\n" +
        "`SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7`"
      );
      return res.status(200).json({ ok: true });
    }

    // ==========================
    // 2) PARSING SEGNALI
    // ==========================
    const match = text.match(
      /(BUY|SELL|BUY_LIMIT|SELL_LIMIT|BUY_STOP|SELL_STOP)\s+([A-Z]+)\s+([\d.]+)\s+SL\s+([\d.]+)\s+TP\s+([\d.]+)/
    );

    if (!match) {
      await sendMessage(chatId, "❌ Formato non riconosciuto.");
      return res.status(200).json({ ok: true });
    }

    const [, rawSide, symbol, entry, sl, tp] = match;

    // tipo di ordine
    const side = rawSide.includes("BUY") ? "BUY" : "SELL";
    const orderKind = rawSide.includes("LIMIT")
      ? "limit"
      : rawSide.includes("STOP")
      ? "stop"
      : "market";

    // ==========================
    // 3) SALVA SU SUPABASE
    // ==========================
    const { error } = await supabase.from("signals").insert({
      side,
      symbol,
      entry,
      sl,
      tp,
      order_kind: orderKind,
    });

    if (error) {
      await sendMessage(chatId, "❌ Errore Supabase: " + error.message);
    } else {
      await sendMessage(chatId, "✅ Segnale salvato e inviato alla dashboard!");
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// =========================
// SEND MESSAGE TO TELEGRAM
// =========================
async function sendMessage(chatId, text) {
  await fetch(`${API_URL}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

// /api/telegram-bot.js
const { createClient } = require("@supabase/supabase-js");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ----------------- UTILS TELEGRAM -----------------
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN mancante");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("Errore sendTelegramMessage:", err);
  }
}

// ----------------- PARSER SEGNALI -----------------
function parseSignal(text) {
  if (!text) return null;

  // Normalizzo: tolgo newline, underscore, doppie spaziature, uppercase
  let norm = text.replace(/[\n\r]+/g, " ");
  norm = norm.replace(/_/g, " ");
  norm = norm.replace(/\s+/g, " ").trim().toUpperCase();

  const sideMatch = norm.match(/\b(BUY|SELL)\b/);
  if (!sideMatch) return null;
  const side = sideMatch[1];

  let orderKind = "market";
  if (/\bLIMIT\b/.test(norm)) orderKind = "limit";
  else if (/\bSTOP\b/.test(norm)) orderKind = "stop";
  else if (/\bNOW\b/.test(norm)) orderKind = "market";

  let symbol = "XAUUSD";
  const symMatch = norm.match(/\b(XAUUSD|XAGUSD|EURUSD)\b/);
  if (symMatch) symbol = symMatch[1];

  // ENTRY: prima provo "ENTRY 4005", poi "ENTRY4005"
  let entry = null;
  let m = norm.match(/\bENTRY\s*([0-9]+(?:\.[0-9]+)?)\b/);
  if (!m) m = norm.match(/\bENTRY([0-9]+(?:\.[0-9]+)?)\b/);
  if (!m) {
    // Se non c'è ENTRY, prendo il numero dopo il simbolo
    const reAfterSymbol = new RegExp(
      symbol + "\\s*([0-9]+(?:\\.[0-9]+)?)"
    );
    m = norm.match(reAfterSymbol);
  }
  if (!m) return null;
  entry = Number(m[1]);

  // SL / TP
  let sl = null;
  let tp = null;
  let slMatch = norm.match(/\bSL\s*([0-9]+(?:\.[0-9]+)?)\b/);
  if (!slMatch) slMatch = norm.match(/\bSL([0-9]+(?:\.[0-9]+)?)\b/);
  if (slMatch) sl = Number(slMatch[1]);

  let tpMatch = norm.match(/\bTP\s*([0-9]+(?:\.[0-9]+)?)\b/);
  if (!tpMatch) tpMatch = norm.match(/\bTP([0-9]+(?:\.[0-9]+)?)\b/);
  if (tpMatch) tp = Number(tpMatch[1]);

  if (!entry || !sl || !tp) {
    return null; // non salvo segnali incompleti
  }

  return {
    side,
    order_kind: orderKind,
    symbol,
    entry,
    sl,
    tp,
    raw_text: text,
  };
}

// ----------------- COMANDI GESTIONE -----------------
async function deleteLastSignal(chatId) {
  const { data, error } = await sb
    .from("signals")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Errore SELECT last for delete:", error);
    await sendTelegramMessage(
      chatId,
      "❌ Errore interno bot (delete)."
    );
    return;
  }
  if (!data || !data.length) {
    await sendTelegramMessage(chatId, "ℹ️ Nessun segnale da cancellare.");
    return;
  }

  const lastId = data[0].id;
  const { error: delErr } = await sb
    .from("signals")
    .delete()
    .eq("id", lastId);

  if (delErr) {
    console.error("Errore delete:", delErr);
    await sendTelegramMessage(
      chatId,
      "❌ Errore interno bot durante la cancellazione."
    );
  } else {
    await sendTelegramMessage(chatId, "✅ Ultimo segnale cancellato.");
  }
}

async function setLastSignalResult(chatId, result) {
  // result: 'win' o 'loss'
  const { data, error } = await sb
    .from("signals")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error("Errore SELECT last for result:", error);
    await sendTelegramMessage(
      chatId,
      "❌ Errore interno bot (result)."
    );
    return;
  }
  if (!data || !data.length) {
    await sendTelegramMessage(chatId, "ℹ️ Nessun segnale da aggiornare.");
    return;
  }

  const lastId = data[0].id;
  const { error: updErr } = await sb
    .from("signals")
    .update({ result })
    .eq("id", lastId);

  if (updErr) {
    console.error("Errore update result:", updErr);
    await sendTelegramMessage(
      chatId,
      "❌ Errore interno bot durante l'aggiornamento del risultato."
    );
  } else {
    const label = result === "win" ? "vinto ✅" : "perso ❌";
    await sendTelegramMessage(
      chatId,
      `📊 Ultimo segnale segnato come ${label}.`
    );
  }
}

// ----------------- HANDLER PRINCIPALE -----------------
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;
    const msg = update.message || update.channel_post;
    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const lower = text.toLowerCase();

    // /start
    if (lower.startsWith("/start")) {
      await sendTelegramMessage(
        chatId,
        "👋 Ciao! Inoltra qui i tuoi segnali XAUUSD.\n" +
          "Esempi riconosciuti:\n" +
          "• SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7\n" +
          "• Buy limit xauusd 4005 SL3995 TP4035\n" +
          "• Sell stop xauusd\\nEntry4040\\nSL4050\\nTP4030\n\n" +
          "Comandi:\n" +
          "• 'cancella' → cancella l'ultimo segnale\n" +
          "• 'hit' → segna l'ultimo segnale come vinto\n" +
          "• 'stop hit' → segna l'ultimo segnale come perso"
      );
      return res.status(200).json({ ok: true });
    }

    // COMANDI TESTUALI
    if (lower === "cancella" || lower === "cancel") {
      await deleteLastSignal(chatId);
      return res.status(200).json({ ok: true });
    }

    if (lower === "hit" || lower === "tp hit") {
      await setLastSignalResult(chatId, "win");
      return res.status(200).json({ ok: true });
    }

    if (lower === "stop hit" || lower === "sl hit") {
      await setLastSignalResult(chatId, "loss");
      return res.status(200).json({ ok: true });
    }

    // PROVO A PARSARE COME SEGNALE
    const parsed = parseSignal(text);

    if (!parsed) {
      await sendTelegramMessage(
        chatId,
        "⚠️ Non ho riconosciuto questo come segnale.\n\nTesto ricevuto:\n" +
          text
      );
      return res.status(200).json({ ok: true });
    }

    // Salvo su Supabase
    const { error: insErr } = await sb.from("signals").insert({
      side: parsed.side,
      order_kind: parsed.order_kind,
      symbol: parsed.symbol,
      entry: parsed.entry,
      sl: parsed.sl,
      tp: parsed.tp,
      raw_text: parsed.raw_text,
    });

    if (insErr) {
      console.error("Errore insert signal:", insErr);
      await sendTelegramMessage(
        chatId,
        "❌ Errore interno bot durante il salvataggio del segnale."
      );
    } else {
      await sendTelegramMessage(
        chatId,
        `✅ Segnale registrato:\n` +
          `${parsed.side} ${parsed.order_kind.toUpperCase()} ${parsed.symbol}\n` +
          `Entry: ${parsed.entry}\nSL: ${parsed.sl} · TP: ${parsed.tp}`
      );
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ ok: true });
  }
};





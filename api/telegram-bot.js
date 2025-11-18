// api/telegram-bot.js
// Endpoint webhook Telegram -> Supabase REST

export default async function handler(req, res) {
  // Telegram manda SOLO POST
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.error("Missing Supabase env vars");
    return res.status(500).json({ ok: false, error: "Server not configured" });
  }

  try {
    const update = req.body || {};
    const msg = update.message || update.channel_post;

    if (!msg || !msg.text) {
      // Nessun testo da parsare (stickers, foto, ecc.)
      return res.status(200).json({ ok: true });
    }

    const rawText = msg.text.trim();
    const text = rawText.toUpperCase();

    // Formato atteso, esempi:
    // BUY XAUUSD 3290 SL 3280 TP 3305
    // SELL_LIMIT XAUUSD 4050 SL 4060 TP 4042.7
    const re =
      /^(BUY|SELL|BUY_LIMIT|SELL_LIMIT|BUY_STOP|SELL_STOP)\s+([A-Z]+)\s+(\d+(?:\.\d+)?)\s+SL\s+(\d+(?:\.\d+)?)\s+TP\s+(\d+(?:\.\d+)?)/;

    const m = text.match(re);

    if (!m) {
      console.log("Messaggio non riconosciuto:", rawText);
      // Rispondiamo “ok” uguale, altrimenti Telegram continua a riprovare
      return res.status(200).json({ ok: true });
    }

    let rawSide = m[1];     // es. BUY, SELL_LIMIT, BUY_STOP
    const symbol = m[2];    // es. XAUUSD
    const entry = Number(m[3]);
    const sl = Number(m[4]);
    const tp = Number(m[5]);

    let order_kind = "market"; // market | limit | stop
    let side = rawSide;

    if (rawSide.endsWith("_LIMIT")) {
      order_kind = "limit";
      side = rawSide.replace("_LIMIT", "");
    } else if (rawSide.endsWith("_STOP")) {
      order_kind = "stop";
      side = rawSide.replace("_STOP", "");
    }

    side = side.toUpperCase(); // BUY / SELL

    const status = order_kind === "market" ? "open" : "pending";

    const payload = {
      source: "telegram",
      symbol,
      side,
      entry,
      sl,
      tp,
      status,
      order_kind,
      raw_text: rawText,
    };

    console.log("Saving signal:", payload);

    // Insert via Supabase REST API
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/signals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error("Supabase error:", data);
      return res.status(500).json({ ok: false, error: "Supabase insert failed" });
    }

    console.log("Supabase insert ok:", data);

    // Risposta per Telegram
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Handler error:", e);
    return res.status(200).json({ ok: true });
  }
}

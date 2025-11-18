export const config = {
  runtime: "nodejs",
};

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// ================== HELPER SUPABASE (via REST) ==================
async function callSupabase(path, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    throw new Error("Supabase env vars mancanti");
  }

  const url = `${SUPABASE_URL}/rest/v1${path}`;

  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      ...options.headers,
    },
    body: options.body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function insertSignal(sig) {
  const rows = await callSupabase("/signals", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([sig]),
  });
  return rows && rows[0];
}

async function getLastOpenSignal() {
  const rows = await callSupabase(
    "/signals?status=eq.open&order=created_at.desc&limit=1"
  );
  if (!rows || !rows.length) return null;
  return rows[0];
}

async function updateSignal(id, patch) {
  const query = `/signals?id=eq.${id}`;
  return callSupabase(query, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

// ================== TELEGRAM ==================
async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN mancante");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}

// ================== PARSING SEGNALI ==================
function parseSignal(text) {
  if (!text) return null;
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // lato = BUY / SELL
  let side = null;
  if (lower.includes("buy")) side = "BUY";
  if (lower.includes("sell")) side = "SELL";

  if (!side) return null;

  // order_kind = market / limit / stop
  let order_kind = "market";
  if (lower.includes("limit")) order_kind = "limit";
  if (lower.includes("stop")) order_kind = "stop";
  if (lower.includes("buy now") || lower.includes("sell now")) {
    order_kind = "market";
  }

  // symbol
  let symbol = "XAUUSD";
  if (lower.includes("xag")) symbol = "XAGUSD";
  if (lower.includes("eurusd")) symbol = "EURUSD";

  // Entry / SL / TP – gestiamo:
  // "Entry 4005" / "Entry4005"
  // "SL 3995" / "SL3995"
  // "TP 4035" / "TP4035"
  const entryMatch = raw.match(/entry\s*([0-9]+(?:\.[0-9]+)?)/i);
  const slMatch = raw.match(/sl\s*([0-9]+(?:\.[0-9]+)?)/i);
  const tpMatch = raw.match(/tp\s*([0-9]+(?:\.[0-9]+)?)/i);

  let entry = entryMatch ? Number(entryMatch[1]) : null;
  let sl = slMatch ? Number(slMatch[1]) : null;
  let tp = tpMatch ? Number(tpMatch[1]) : null;

  // fallback: "BUY LIMIT XAUUSD 4005 SL 3995 TP 4035"
  if (!entry || !sl || !tp) {
    const nums = raw.match(/[0-9]+(?:\.[0-9]+)?/g) || [];
    if (!entry && nums.length >= 1) entry = Number(nums[0]);
    if (!sl && nums.length >= 2) sl = Number(nums[1]);
    if (!tp && nums.length >= 3) tp = Number(nums[2]);
  }

  if (!entry || !sl || !tp) {
    return null;
  }

  return {
    source: "telegram",
    symbol,
    side,
    entry,
    sl,
    tp,
    status: "open",
    raw_text: raw,
    order_kind,
  };
}

// ================== HANDLER PRINCIPALE ==================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  try {
    const update = req.body;
    const msg = update && update.message;
    if (!msg) {
      return res.status(200).json({ ok: true });
    }

    const chatId = msg.chat.id;
    const text = (msg.text || msg.caption || "").trim();
    if (!text) {
      return res.status(200).json({ ok: true });
    }

    const lower = text.toLowerCase();

    // ===== COMANDI SPECIALI =====

    // 1) Cancella ultimo segnale aperto
    if (lower === "cancella" || lower === "cancellare") {
      const last = await getLastOpenSignal();
      if (!last) {
        await sendTelegram(chatId, "⚠️ Nessun segnale aperto da cancellare.");
      } else {
        await updateSignal(last.id, {
          status: "cancelled",
          result: "cancelled",
        });
        await sendTelegram(
          chatId,
          `✅ Ultimo segnale <b>ID ${last.id}</b> è stato <b>cancellato</b>.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // 2) HIT = TP colpito → WIN
    if (lower === "hit") {
      const last = await getLastOpenSignal();
      if (!last) {
        await sendTelegram(chatId, "⚠️ Nessun segnale aperto da marcare come win.");
      } else {
        await updateSignal(last.id, {
          status: "closed",
          result: "win",
        });
        await sendTelegram(
          chatId,
          `✅ Segnale <b>ID ${last.id}</b> marcato come <b>WIN (TP hit)</b>.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // 3) STOP HIT / SL HIT = SL colpito → LOSS
    if (
      lower === "stop hit" ||
      lower === "stophit" ||
      lower === "stop-hit" ||
      lower === "sl hit" ||
      lower === "slhit"
    ) {
      const last = await getLastOpenSignal();
      if (!last) {
        await sendTelegram(chatId, "⚠️ Nessun segnale aperto da marcare come loss.");
      } else {
        await updateSignal(last.id, {
          status: "closed",
          result: "loss",
        });
        await sendTelegram(
          chatId,
          `❌ Segnale <b>ID ${last.id}</b> marcato come <b>LOSS (SL hit)</b>.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ===== PROVA A PARSARE UN SEGNALE =====
    const parsed = parseSignal(text);

    if (!parsed) {
      await sendTelegram(
        chatId,
        `⚠️ Non ho riconosciuto questo come segnale.\n\nTesto ricevuto:\n<code>${text}</code>`
      );
      return res.status(200).json({ ok: true });
    }

    const row = await insertSignal(parsed);

    await sendTelegram(
      chatId,
      [
        "✅ Segnale registrato:",
        `${parsed.side} ${parsed.order_kind.toUpperCase()} ${parsed.symbol}`,
        `Entry: <b>${parsed.entry}</b>`,
        `SL: <b>${parsed.sl}</b> · TP: <b>${parsed.tp}</b>`,
      ].join("\n")
    );

    console.log("Signal inserted", row || parsed);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(200).json({ ok: false, error: String(err) });
  }
}





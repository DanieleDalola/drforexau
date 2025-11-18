// api/telegram-bot.js

const TELEGRAM_TOKEN          = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL            = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE   = process.env.SUPABASE_SERVICE_ROLE;

async function callTelegram(method, payload) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram API error:', data);
  }
  return data;
}

async function supabaseRequest(path, method = 'GET', body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
  };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['Prefer'] = 'return=representation';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('Supabase error', res.status, text);
    throw new Error(text);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// =====================
// PARSING SEGNALI
// =====================
function parseSignal(textRaw) {
  if (!textRaw) return null;

  // normalizza: spazi, underscore -> spazio, maiuscolo
  let t = textRaw.replace(/\s+/g, ' ').replace(/_/g, ' ').trim().toUpperCase();

  // es: "BUY LIMIT XAUUSD 4005 SL 3995 TP 4035"
  //     "SELL NOW XAUUSD 4040 SL 4050 TP 4005"
  const re = /(BUY|SELL)\s+(LIMIT|STOP|NOW)\s+([A-Z0-9/]+)\s+([0-9]+(?:\.[0-9]+)?)(?:\s+SL\s+([0-9]+(?:\.[0-9]+)?))?(?:\s+TP\s+([0-9]+(?:\.[0-9]+)?))?/;
  const m = t.match(re);
  if (!m) return null;

  const side = m[1];          // BUY / SELL
  const kindWord = m[2];      // LIMIT / STOP / NOW
  const symbol = m[3];        // XAUUSD
  const entry  = parseFloat(m[4]);
  const sl     = m[5] ? parseFloat(m[5]) : null;
  const tp     = m[6] ? parseFloat(m[6]) : null;

  let orderKind = 'market';
  if (kindWord === 'LIMIT') orderKind = 'limit';
  else if (kindWord === 'STOP') orderKind = 'stop';

  return { side, order_kind: orderKind, symbol, entry, sl, tp };
}

// segna ultimo segnale aperto (result IS NULL) come win/loss
async function markLastResult(result) {
  const rows = await supabaseRequest(
    'signals?select=id&result=is.null&order=created_at.desc&limit=1',
    'GET'
  );
  if (!rows || !rows.length) return false;

  const id = rows[0].id;
  await supabaseRequest(`signals?id=eq.${id}`, 'PATCH', { result });
  return true;
}

// cancella l'ultimo segnale (indipendentemente dal result)
async function deleteLastSignal() {
  const rows = await supabaseRequest(
    'signals?select=id&order=created_at.desc&limit=1',
    'GET'
  );
  if (!rows || !rows.length) return false;

  const id = rows[0].id;
  await supabaseRequest(`signals?id=eq.${id}`, 'DELETE');
  return true;
}

// =====================
// HANDLER PRINCIPALE
// =====================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  const update = req.body;
  const msg = update.message || update.channel_post;
  if (!msg || !msg.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const lower  = text.toLowerCase();

  try {
    // 1) COMANDI BASE
    if (lower === '/start' || lower === '/start@drforexausignalsbot') {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Ciao, sono il bot DR-Forexau.\n\nFormato segnali:\nBUY LIMIT XAUUSD 4005 SL 3995 TP 4035\nSELL STOP XAUUSD 3990 SL 4010 TP 3950\n\nComandi:\n- "hit" ➜ segna ultimo segnale aperto come WIN\n- "stop hit" ➜ segna ultimo segnale aperto come LOSS\n- "cancella" ➜ elimina ultimo segnale',
      });
      return res.status(200).json({ ok: true });
    }

    if (lower === '/test') {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: '✅ Bot attivo e collegato alla dashboard.',
      });
      return res.status(200).json({ ok: true });
    }

    // 2) GESTIONE RISULTATI
    // "hit" -> WIN
    if (lower === 'hit' || lower.includes('tp hit')) {
      const ok = await markLastResult('win');
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: ok
          ? '✅ Ultimo segnale segnato come WIN (hit).'
          : '⚠️ Nessun segnale aperto da segnare come WIN.',
      });
      return res.status(200).json({ ok: true });
    }

    // "stop hit" -> LOSS
    if (lower.includes('stop hit')) {
      const ok = await markLastResult('loss');
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: ok
          ? '⚠️ Ultimo segnale segnato come LOSS (stop hit).'
          : '⚠️ Nessun segnale aperto da segnare come LOSS.',
      });
      return res.status(200).json({ ok: true });
    }

    // "cancella" -> cancella ultimo segnale
    if (lower === 'cancella' || lower.startsWith('cancella ')) {
      const ok = await deleteLastSignal();
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: ok
          ? '🗑️ Ultimo segnale cancellato dalla dashboard.'
          : '⚠️ Nessun segnale da cancellare.',
      });
      return res.status(200).json({ ok: true });
    }

    // 3) SEGNALI OPERATIVI
    const parsed = parseSignal(text);
    if (!parsed) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: '⚠️ Non ho riconosciuto questo come segnale.\n\nTesto ricevuto:\n' + text,
      });
      return res.status(200).json({ ok: true });
    }

    const row = {
      symbol: parsed.symbol,
      side: parsed.side,
      order_kind: parsed.order_kind,
      entry: parsed.entry,
      sl: parsed.sl,
      tp: parsed.tp,
      result: null,         // aperto finché non mandi "hit" o "stop hit"
      raw_text: text,
    };

    await supabaseRequest('signals', 'POST', row);

    await callTelegram('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text:
        '✅ Segnale registrato:\n' +
        `<b>${parsed.side} ${parsed.order_kind.toUpperCase()} ${parsed.symbol}</b>\n` +
        `Entry: <b>${parsed.entry}</b>\n` +
        `SL: <b>${parsed.sl ?? '—'}</b> · TP: <b>${parsed.tp ?? '—'}</b>`,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error:', err);
    try {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: '❌ Errore interno bot: ' + (err.message || err),
      });
    } catch (e) {
      console.error('Errore anche nell’invio su Telegram', e);
    }
    return res.status(200).json({ ok: true });
  }
}




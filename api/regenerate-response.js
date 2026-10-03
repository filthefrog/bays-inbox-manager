import { claudeKey, requireAuth, romeDate } from '../lib/auth.js';
import { generateVariant } from '../lib/analyze-email.js';
import { callClaude, flushUsage } from '../lib/claude.js';
import { getOccupied, occupiedText } from '../lib/availability.js';

// Rigenera UNA risposta a partire da un'istruzione extra data dall'host,
// per i casi in cui nessuna delle 3 risposte generate automaticamente va
// bene — tipicamente perché il cliente fa riferimento a qualcosa che l'host
// sa ma che non è scritto da nessuna parte nella mail originale.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  const apiKey = await claudeKey(req, res);
  if (!apiKey) return;

  // Risposta "Fermo" o "Deciso" generata solo quando la si tocca nell'app.
  // Viene aggiunta alla cache dell'email, così non si paga una seconda volta
  // (né su un altro telefono, né dopo un aggiornamento).
  if (req.body && req.body.variant) {
    const { variant, emailId, from, subject, body: mailBody, discrepancy } = req.body;
    if (!mailBody) return res.status(400).json({ error: 'Manca il testo della mail originale' });
    const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
    const canCache = !!(SUPABASE_URL && SUPABASE_KEY && emailId && /^[\w-]{6,64}$/.test(emailId));
    if (canCache && !(await requireAuth(req, res))) return;
    try {
      // Già generata da un altro dispositivo? Allora niente chiamata all'IA
      let row = null;
      if (canCache) {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/analyzed_emails?id=eq.${emailId}&select=responses`, { headers: h });
        row = r.ok ? (await r.json())[0] : null;
        const list = row && Array.isArray(row.responses) ? row.responses : [];
        const hit = list.find(x => x && x.variant === variant);
        if (hit) return res.status(200).json({ response: hit, cached: true });
      }
      let context = {};
      try {
        const today = romeDate();
        const { ranges } = await getOccupied({ from: today, to: romeDate(365) });
        context = { today, occupied: ranges.length ? occupiedText(ranges) : '- nessuna data occupata nei prossimi 12 mesi' };
      } catch (e) {}
      const response = await generateVariant({ from, subject, body: mailBody, discrepancy }, variant, apiKey, context);
      if (canCache && row) {
        const list = Array.isArray(row.responses) ? row.responses : [];
        await fetch(`${SUPABASE_URL}/rest/v1/analyzed_emails?id=eq.${emailId}`, {
          method: 'PATCH',
          headers: { ...h, 'Content-Type': 'application/json' },
          body: JSON.stringify({ responses: [...list, response] })
        }).catch(() => {});
      }
      await flushUsage();
      return res.status(200).json({ response });
    } catch (err) {
      await flushUsage();
      return res.status(502).json({ error: err.message || 'Generazione non riuscita' });
    }
  }

  const { subject, body, category, extraInstruction, guestName } = req.body || {};
  if (!extraInstruction || !extraInstruction.trim()) {
    return res.status(400).json({ error: 'Manca il dettaglio da usare per la rigenerazione' });
  }
  if (!body) {
    return res.status(400).json({ error: 'Manca il testo della mail originale' });
  }

  const systemPrompt = `Scrivi la risposta via email di Domus 106 (affittacamere) a un ospite, in italiano.

Dai SEMPRE del Lei all'ospite, mai del tu, anche se il cliente scrive dando del tu.

Tono — questa è la linea guida per OGNI risposta che generi, sempre: cordiale e calda, come scriverebbe una persona che gestisce con cura il proprio affittacamere, MAI artificiale, rigida o da modulo precompilato. Evita frasi fatte da email aziendale generica ("Si prega di", "Restiamo in attesa di un suo cortese riscontro"). Scrivi come scriverebbe davvero l'host: diretto, gentile, naturale.

Usa SEMPRE, con priorità assoluta, il dettaglio che l'host ti fornisce qui sotto: è un'informazione che l'host conosce ma che non è scritta nella mail del cliente (es. una disponibilità, una regola, qualcosa detto a voce in precedenza). Se il dettaglio corregge o aggiunge qualcosa rispetto a quanto il cliente ha scritto, la risposta deve riflettere chiaramente quella correzione.

Rispondi SOLO con il testo della mail (nessun oggetto, nessuna nota, nessuna spiegazione prima o dopo).`;

  const userPrompt = `Mail originale del cliente${guestName ? ' (' + guestName + ')' : ''}:
Oggetto: ${subject || '(nessun oggetto)'}
${category ? 'Categoria: ' + category : ''}

"""
${body}
"""

Dettaglio da parte dell'host, da usare per scrivere la risposta corretta:
"""
${extraInstruction.trim()}
"""`;

  try {
    const text = await callClaude(apiKey, `${systemPrompt}\n\n${userPrompt}`, 1500);
    await flushUsage();

    if (!text) {
      return res.status(502).json({ error: 'Risposta vuota dal modello' });
    }

    return res.status(200).json({ text });

  } catch (error) {
    await flushUsage();
    console.error('regenerate-response error:', error);
    return res.status(500).json({ error: error.message || 'Errore sconosciuto' });
  }
}

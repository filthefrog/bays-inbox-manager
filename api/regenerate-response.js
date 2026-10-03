import { claudeKey } from '../lib/auth.js';

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

  const { subject, body, category, extraInstruction, guestName } = req.body || {};
  if (!extraInstruction || !extraInstruction.trim()) {
    return res.status(400).json({ error: 'Manca il dettaglio da usare per la rigenerazione' });
  }
  if (!body) {
    return res.status(400).json({ error: 'Manca il testo della mail originale' });
  }

  const systemPrompt = `Scrivi la risposta via email di Domus 106 (affittacamere) a un ospite, in italiano.

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
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(r.status === 401 ? 401 : 502).json({
        error: 'Generazione fallita: ' + detail.slice(0, 200)
      });
    }

    const data = await r.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!text) {
      return res.status(502).json({ error: 'Risposta vuota dal modello' });
    }

    return res.status(200).json({ text });

  } catch (error) {
    console.error('regenerate-response error:', error);
    return res.status(500).json({ error: error.message || 'Errore sconosciuto' });
  }
}

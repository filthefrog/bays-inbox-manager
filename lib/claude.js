// Unico punto da cui l'app chiama Claude: modello, parametri e conteggio
// della spesa stanno qui. Usato da analisi email, varianti di risposta,
// rigenerazione e messaggio del preventivo.
import { stateGet, stateSet } from './availability.js';

// Claude Sonnet 5.5: scrive meglio di Haiku 4.5 (registro formale, toni
// sfumati) a $2 / $10 per milione di token in ingresso / uscita.
// Sforzo "low": per email brevi il modello ragiona poco o niente e risponde
// subito; il ragionamento conta nei token di uscita, quindi max_tokens ha
// margine.
export const MODEL = 'claude-sonnet-5-5';
const PRICE = { input: 2 / 1e6, output: 10 / 1e6 }; // dollari per token

// Spesa accumulata in questa esecuzione, scritta su Supabase con flushUsage()
// a fine richiesta (una scrittura sola anche con più analisi in parallelo).
const pending = { input: 0, output: 0, usd: 0, calls: 0 };

export async function callClaude(apiKey, prompt, maxTokens) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Se il modello rifiuta per un filtro di sicurezza, Anthropic riprova
      // da sola su un modello adatto invece di restituire un rifiuto
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error('Claude API error: ' + errBody.slice(0, 200));
  }
  const data = await response.json();
  const u = data.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  pending.input += inTok;
  pending.output += outTok;
  pending.usd += inTok * PRICE.input + outTok * PRICE.output;
  pending.calls += 1;
  if (data.stop_reason === 'refusal') throw new Error('Il modello ha rifiutato di rispondere a questa email');
  // Si leggono solo i blocchi di testo: eventuali blocchi di ragionamento
  // (vuoti) o di fallback non fanno parte della risposta
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// Somma la spesa di questa esecuzione al totale salvato (per mese)
export async function flushUsage() {
  if (!pending.calls || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return;
  const add = { ...pending };
  pending.input = pending.output = pending.usd = pending.calls = 0;
  try {
    let all = {};
    try { all = JSON.parse((await stateGet('ai_usage')) || '{}'); } catch (e) { all = {}; }
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date()).slice(0, 7);
    all.months = all.months || {};
    const m = all.months[month] || (all.months[month] = { input: 0, output: 0, usd: 0, calls: 0 });
    m.input += add.input; m.output += add.output; m.usd = Math.round((m.usd + add.usd) * 1e6) / 1e6; m.calls += add.calls;
    all.since = all.since || new Date().toISOString();
    await stateSet('ai_usage', JSON.stringify(all));
  } catch (e) {}
}

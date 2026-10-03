import { PRICING, pricingKnowledge } from './pricing.js';

// Prompt e dati reali della struttura, in UN SOLO posto — usato da
// api/emails-analyzed.js, api/analyze-single.js e api/check-urgent.js.
// Se cambi qualcosa sulla struttura (prezzi, servizi, ecc.) va aggiornato solo qui.

// Dati della struttura per l'IA. Prezzi e regole di prenotazione arrivano dal
// listino unico (lib/pricing.js), così non possono divergere dal preventivo.
export const KNOWLEDGE_BASE = `
- Nome struttura: Domus 106
- Indirizzo: Via Papa Giovanni XXIII, 106, Civitanova Marche (MC)
- Appartamento di 75 mq al 1° piano con ascensore: 2 camere matrimoniali, 4 posti letto, 2 bagni completi. Colazione non inclusa.
- Parcheggio: garage privato coperto e interrato incluso
- WiFi: fibra ottica
- Check-in: qualsiasi ora (self check-in con codice digitale)
- Check-out: entro le ${PRICING.checkoutTime}
${pricingKnowledge()}
- Spiaggia a circa 1,6 km
- Cancellazione: entro 14 giorni dall'arrivo rimborso totale; 7-14 giorni rimborso 50%; entro 7 giorni nessun rimborso
`;

export const CATEGORIES = ['Lamentela', 'Da verificare', 'Prenotazione', 'Problema tecnico', 'Fatturazione', 'Richiesta informazioni', 'Complimento', 'Cancellazione'];

// Le tre risposte possibili, dalla più accomodante alla più ferma. All'arrivo
// dell'email si genera SOLO la cortese (verde): le altre due costano token e
// servono di rado, quindi si generano quando le si tocca (generateVariant).
export const VARIANTS = {
  cortese: { label: 'Cortese', color: 'green', guide: "massima gentilezza e disponibilità, tono accomodante. Adatta quando il cliente ha chiaramente ragione o la richiesta è semplice e senza attrito." },
  fermo: { label: 'Fermo', color: 'orange', guide: "educata ma con più distanza. La struttura non concede automaticamente ragione, chiede chiarimenti se ci sono incongruenze, pone dei paletti chiari." },
  deciso: { label: 'Deciso', color: 'red', guide: "ferma e assertiva, protegge chiaramente gli interessi della struttura. Adatta per casi di possibile malafede, richieste infondate, dispute su danni o pagamenti. Resta sempre professionale e mai offensiva, ma non lascia spazio ad ambiguità." }
};

const MODEL = "claude-haiku-4-5-20251001";

// Solo il messaggio nuovo: la cronologia citata ("Il giorno … ha scritto:",
// righe con ">", messaggio originale inoltrato) è testo già visto che
// costava token a ogni analisi senza aggiungere informazioni.
export function messageForPrompt(body) {
  const lines = String(body || '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(il giorno .+ ha scritto:?|on .+ wrote:?|-{2,}\s*(original message|messaggio originale)\s*-{2,}|da:\s.+|from:\s.+@.+)$/i.test(t) && out.join('').trim()) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim().slice(0, 2500) || String(body || '').slice(0, 2500);
}

const PRINCIPLES = `PRINCIPI FONDAMENTALI:
- Rappresenti SEMPRE gli interessi della struttura. Non dai per scontato che il cliente abbia automaticamente ragione.
- Controlla con attenzione il contenuto dell'email per individuare errori, incongruenze o affermazioni che non tornano (esempio: il cliente scrive "3 notti" ma le date indicate coprono un periodo diverso). Se ce ne sono, menzionale con garbo ma chiarezza nella risposta, chiedendo conferma invece di darle per scontate.
- Il tono di fondo è SEMPRE educato, caldo e professionale — mai scortese o aggressivo.
- Scrivi come scriverebbe davvero una persona alla scrivania, non come un modulo automatico: evita frasi fatte da form standard, evita la struttura troppo perfetta e simmetrica tipica di un testo generato da IA, evita elenchi puntati dentro l'email. Varia la lunghezza delle frasi, tono colloquiale ma curato, come un gestore che conosce il mestiere e risponde di persona.`;

function contextBlock(context) {
  return context.occupied ? `DATE GIÀ OCCUPATE (oggi è il ${context.today}; non confermare mai disponibilità in queste notti, proponi date alternative libere):
${context.occupied}
` : '';
}

async function callClaude(apiKey, prompt, maxTokens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  if (!response.ok) {
    const errBody = await response.text();
    throw new Error("Claude API error: " + errBody.slice(0, 200));
  }
  const data = await response.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

// Classificazione + la sola risposta cortese.
// context.occupied: testo con le date già occupate (da ACME, Booking e Airbnb),
// così l'IA non conferma disponibilità che non c'è.
export async function analyzeAndRespond(email, apiKey, context = {}) {
  const prompt = `Sei l'assistente di gestione per Domus 106, un affittacamere a Civitanova Marche. Aiuti il gestore a rispondere alle email dei clienti.

DATI REALI DELLA STRUTTURA (usali per rispondere correttamente, non inventare altro):
${KNOWLEDGE_BASE}
${contextBlock(context)}
${PRINCIPLES}

Email ricevuta:
From: ${email.from}
Subject: ${email.subject}
Body: ${messageForPrompt(email.body)}

GENERA:
1. category: una tra Lamentela, Prenotazione, Problema tecnico, Fatturazione, Richiesta informazioni, Complimento, Cancellazione, Da verificare. Usa «Da verificare» solo quando il messaggio è troppo vago, ambiguo o privo di contesto per scegliere con sicurezza una delle altre.
2. tone: il tono emotivo del CLIENTE (non della risposta), una tra Cortese, Neutro, Urgente, Arrabbiato
3. discrepancy: se noti un errore o un'incongruenza nel messaggio del cliente, descrivila in una frase breve e concreta. Se non c'è nulla di sospetto, scrivi esattamente null.
4. response: la risposta email, ${VARIANTS.cortese.guide}

Rispondi SOLO con questo JSON:
{"category": "...", "tone": "...", "discrepancy": "..." oppure null, "response": "..."}`;

  const responseText = await callClaude(apiKey, prompt, 900);
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");
  const parsed = JSON.parse(jsonMatch[0]);

  // Una categoria fuori elenco finirebbe in un gruppo che la dashboard non
  // mostra: l'email sparirebbe senza avviso. Meglio «Da verificare».
  const category = CATEGORIES.includes(parsed.category) ? parsed.category : "Da verificare";
  const text = parsed.response || parsed.response_cortese || 'Risposta non generata';

  return {
    category,
    tone: parsed.tone || "Neutro",
    discrepancy: (parsed.discrepancy && parsed.discrepancy !== 'null') ? parsed.discrepancy : null,
    responses: [{ label: VARIANTS.cortese.label, color: VARIANTS.cortese.color, variant: 'cortese', text }]
  };
}

// Una sola risposta di un tono diverso, generata quando la si chiede
export async function generateVariant(email, variant, apiKey, context = {}) {
  const v = VARIANTS[variant];
  if (!v) throw new Error('Tipo di risposta sconosciuto');
  const prompt = `Scrivi la risposta via email di Domus 106 (affittacamere a Civitanova Marche) a questo cliente, in italiano.

DATI REALI DELLA STRUTTURA (non inventare altro):
${KNOWLEDGE_BASE}
${contextBlock(context)}
${PRINCIPLES}

Tono richiesto (${v.label}): ${v.guide}
${email.discrepancy ? `Incongruenza già notata nel messaggio: ${email.discrepancy}\n` : ''}
Email ricevuta:
From: ${email.from}
Subject: ${email.subject}
Body: ${messageForPrompt(email.body)}

Rispondi SOLO con il testo della mail (niente oggetto, note o spiegazioni). Firma come "Domus 106".`;
  const text = await callClaude(apiKey, prompt, 800);
  if (!text) throw new Error('Risposta vuota dal modello');
  return { label: v.label, color: v.color, variant, text };
}

// Testo dell'email. Gmail annida le parti (multipart/mixed → multipart/alternative
// → text/plain) quando ci sono allegati o versioni HTML: prima si cercava solo
// al primo livello e quelle email arrivavano a Claude come "(No body)".
export function extractBody(payload) {
  const decode = (data) => Buffer.from(data, "base64").toString("utf-8");
  const find = (part, mime) => {
    if (!part) return null;
    if (part.mimeType === mime && part.body && part.body.data) return part.body.data;
    for (const p of part.parts || []) {
      const hit = find(p, mime);
      if (hit) return hit;
    }
    return null;
  };
  const plain = find(payload, "text/plain");
  if (plain) return decode(plain).slice(0, 3000);
  const html = find(payload, "text/html");
  if (html) {
    const text = decode(html)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
    if (text) return text.slice(0, 3000);
  }
  if (payload && payload.body && payload.body.data) return decode(payload.body.data).slice(0, 3000);
  return "(No body)";
}

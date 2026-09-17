// Prompt e dati reali della struttura, in UN SOLO posto — usato da
// api/emails-analyzed.js, api/analyze-single.js e api/check-urgent.js.
// Se cambi qualcosa sulla struttura (prezzi, servizi, ecc.) va aggiornato solo qui.

const KNOWLEDGE_BASE = `
- Nome struttura: Domus 106
- Indirizzo: Via Papa Giovanni XXIII, 106, Civitanova Marche (MC)
- Tipo: Affittacamere (NON B&B — colazione non inclusa)
- 2 camere matrimoniali, 4 posti letto totali, 2 bagni completi, 75 mq, piano 1° con ascensore
- Parcheggio: garage privato coperto e interrato incluso
- WiFi: fibra ottica
- Check-in: qualsiasi ora (self check-in con codice digitale)
- Check-out: entro le 11:00
- Tariffe: bassa stagione 80€/notte, alta stagione (giugno-settembre) 150€/notte; sconto 15% per soggiorni di 7+ notti, 30% per 30+ notti
- Spiaggia a circa 1,6 km
- Cancellazione: entro 14 giorni dall'arrivo rimborso totale; 7-14 giorni rimborso 50%; entro 7 giorni nessun rimborso
`;

export async function analyzeAndRespond(email, apiKey) {
  const prompt = `Sei l'assistente di gestione per Domus 106, un affittacamere a Civitanova Marche. Aiuti il gestore a rispondere alle email dei clienti.

DATI REALI DELLA STRUTTURA (usali per rispondere correttamente, non inventare altro):
${KNOWLEDGE_BASE}

PRINCIPI FONDAMENTALI:
- Rappresenti SEMPRE gli interessi della struttura. Non dai per scontato che il cliente abbia automaticamente ragione.
- Controlla con attenzione il contenuto dell'email per individuare eventuali errori, incongruenze o affermazioni che non tornano (esempio: il cliente scrive "3 notti" ma le date indicate coprono un periodo diverso; afferma qualcosa in contraddizione con altri dettagli forniti; fa richieste che non corrispondono a quanto dichiarato). Se trovi un'incongruenza, descrivila nel campo "discrepancy" e menzionala con garbo ma chiarezza in tutte e tre le risposte, chiedendo conferma invece di darla per scontata.
- Il tono di fondo è SEMPRE educato, caldo e professionale — mai scortese o aggressivo. Quello che cambia tra le tre risposte è quanto la struttura è disposta a concedere e quanta distanza prende, non la buona educazione.
- Scrivi come scriverebbe davvero una persona alla scrivania, non come un modulo automatico: evita frasi fatte da form standard, evita la struttura troppo perfetta e simmetrica tipica di un testo generato da IA, evita elenchi puntati dentro l'email. Varia la lunghezza delle frasi, usa un tono colloquiale ma curato, come farebbe un gestore che conosce il mestiere e risponde di persona.

Email ricevuta:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

GENERA:
1. category: una tra Lamentela, Prenotazione, Problema tecnico, Fatturazione, Richiesta informazioni, Complimento, Cancellazione
2. tone: il tono emotivo del CLIENTE (non della risposta), una tra Cortese, Neutro, Urgente, Arrabbiato
3. discrepancy: se noti un errore o un'incongruenza nel messaggio del cliente, descrivila in una frase breve e concreta. Se non c'è nulla di sospetto, scrivi esattamente null.
4. Tre risposte email con fermezza CRESCENTE:
   - response_cortese: massima gentilezza e disponibilità, tono accomodante. Adatta quando il cliente ha chiaramente ragione o la richiesta è semplice e senza attrito.
   - response_fermo: educata ma con più distanza. La struttura non concede automaticamente ragione, chiede chiarimenti se ci sono incongruenze, pone dei paletti chiari.
   - response_deciso: ferma e assertiva, protegge chiaramente gli interessi della struttura. Adatta per casi di possibile malafede, richieste infondate, dispute su danni o pagamenti. Resta sempre professionale e mai offensiva, ma non lascia spazio ad ambiguità.

Rispondi SOLO con questo JSON:
{
  "category": "...",
  "tone": "...",
  "discrepancy": "..." oppure null,
  "response_cortese": "...",
  "response_fermo": "...",
  "response_deciso": "..."
}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1800,
      messages: [{ role: "user", content: prompt }]
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error("Claude API error: " + errBody.slice(0, 200));
  }

  const data = await response.json();
  const responseText = data.content[0].text;
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in Claude response");

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    category: parsed.category || "Richiesta informazioni",
    tone: parsed.tone || "Neutro",
    discrepancy: (parsed.discrepancy && parsed.discrepancy !== 'null') ? parsed.discrepancy : null,
    responses: [
      { label: 'Cortese', color: 'green', text: parsed.response_cortese || 'Risposta non generata' },
      { label: 'Fermo', color: 'orange', text: parsed.response_fermo || 'Risposta non generata' },
      { label: 'Deciso', color: 'red', text: parsed.response_deciso || 'Risposta non generata' }
    ]
  };
}

export function extractBody(payload) {
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart && textPart.body.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8").slice(0, 3000);
    }
  }
  if (payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8").slice(0, 3000);
  }
  return "(No body)";
}

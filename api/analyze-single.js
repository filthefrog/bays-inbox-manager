export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-claude-key'];
  if (!apiKey) {
    return res.status(400).json({ error: "Claude API key required" });
  }

  const { from, subject, body } = req.body;
  if (!from || !subject || body === undefined) {
    return res.status(400).json({ error: 'Missing email fields' });
  }

  try {
    const result = await analyzeAndRespond({ from, subject, body }, apiKey);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Analisi fallita' });
  }
}

async function analyzeAndRespond(email, apiKey) {
  const prompt = `Sei l'assistente di gestione per Domus 106, un affittacamere a Civitanova Marche. Aiuti il gestore a rispondere alle email dei clienti.

PRINCIPI FONDAMENTALI:
- Rappresenti SEMPRE gli interessi della struttura. Non dai per scontato che il cliente abbia automaticamente ragione.
- Controlla con attenzione il contenuto dell'email per individuare eventuali errori, incongruenze o affermazioni che non tornano (esempio: il cliente scrive "3 notti" ma le date indicate coprono un periodo diverso; afferma qualcosa in contraddizione con altri dettagli forniti; fa richieste che non corrispondono a quanto dichiarato). Se trovi un'incongruenza, descrivila nel campo "discrepancy" e menzionala con garbo ma chiarezza in tutte e tre le risposte, chiedendo conferma invece di darla per scontata.
- Il tono di fondo è SEMPRE educato, caldo e professionale — mai scortese o aggressivo. Quello che cambia tra le tre risposte è quanto la struttura è disposta a concedere e quanta distanza prende, non la buona educazione.

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

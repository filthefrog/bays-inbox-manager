export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-claude-key'];
  if (!apiKey) {
    return res.status(400).json({ error: 'Claude API key required' });
  }

  const {
    originalSubject, originalBody, guestName,
    checkInFmt, checkOutFmt, nights, ratePerNight, discountPercent, total, season
  } = req.body;

  if (!guestName || !checkInFmt || !checkOutFmt || !nights || !ratePerNight || !total) {
    return res.status(400).json({ error: 'Dati del preventivo mancanti' });
  }

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

  const prompt = `Sei l'assistente di gestione per Domus 106, un affittacamere a Civitanova Marche. Il gestore ha già preparato un preventivo di soggiorno per un cliente e lo allegherà in PDF a questa email. Il tuo compito è scrivere SOLO il testo dell'email di accompagnamento.

DATI REALI DELLA STRUTTURA (usali se il cliente ha fatto domande su servizi/orari):
${KNOWLEDGE_BASE}

EMAIL RICEVUTA DAL CLIENTE:
Oggetto: ${originalSubject || '(nessun oggetto)'}
Testo: ${originalBody || '(nessun testo)'}

PREVENTIVO GIÀ CALCOLATO (non ricalcolare nulla, usa questi numeri così come sono):
- Ospite: ${guestName}
- Check-in: ${checkInFmt}
- Check-out: ${checkOutFmt}
- Notti: ${nights}
- Stagione: ${season || ''}
- Tariffa a notte: € ${ratePerNight}
${discountPercent > 0 ? `- Sconto applicato: ${discountPercent}%\n` : ''}- Totale soggiorno: € ${total}

ISTRUZIONI:
- Scrivi un'email di risposta che affronti DAVVERO quello che il cliente ha scritto: se ha fatto domande specifiche (su parcheggio, orari, servizi, ecc.) rispondi anche a quelle usando i dati reali sopra, non solo il preventivo
- Menziona che il preventivo dettagliato è allegato in PDF
- Includi nel testo le date del soggiorno e il totale
- Scrivi come scriverebbe davvero una persona alla scrivania, non come un modulo automatico: evita frasi fatte da form standard, evita la struttura troppo perfetta e simmetrica tipica di un testo generato da IA, evita elenchi puntati. Varia la lunghezza delle frasi, tono colloquiale ma curato
- Firma come "Domus 106"
- Rispondi SOLO con il testo dell'email, niente introduzioni, niente markdown, niente virgolette attorno al testo`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error("Claude API error: " + errBody.slice(0, 200));
    }

    const data = await response.json();
    const message = data.content[0].text.trim();

    return res.status(200).json({ message });
  } catch (error) {
    console.error('Errore generazione messaggio preventivo:', error);
    return res.status(500).json({ error: error.message });
  }
}

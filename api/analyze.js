export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from, subject, body, apiKey } = req.body;

  if (!from || !subject || !body || !apiKey) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const KNOWLEDGE_BASE = {
    name: "BAYS",
    address: "Via Papa Giovanni XXIII, 106, Civitanova Marche (MC)",
    type: "Affittacamere",
    rooms: 2,
    beds: 4,
    bathrooms: 2,
    sqm: 75,
    priceHigh: "€150/notte",
    priceLow: "€80/notte",
    discount7nights: "-15%",
    discount30nights: "-30%",
    beach: "1,6 km",
    parking: "Garage privato incluso",
    wifi: "Fibra ottica 100 Mbps",
    checkin: "Qualsiasi ora (self check-in digitale)",
    checkout: "Entro le 11:00",
    cancellation: "Entro 14 giorni: rimborso totale. 7-14 giorni: 50%. Entro 7: nessun rimborso",
    noBreakfast: "No colazione (affittacamere autonomo)",
    contactEmail: "info@baysvilla.it",
    contactPhone: "+39 375 XXXXXX"
  };

  try {
    // Step 1: Categorizzazione
    const categoryPrompt = `Sei un assistente per il gestionale di un affittacamere (BAYS, Civitanova Marche).
    
Categorizza questa email in UNA sola categoria:
- Lamentela
- Prenotazione
- Problema tecnico
- Fatturazione
- Richiesta informazioni
- Complimento
- Cancellazione

Email:
From: ${from}
Subject: ${subject}
Body: ${body}

Rispondi solo con: "Categoria: [nome categoria]" e "Tone: [Cortese/Neutro/Urgente/Arrabbiato]"`;

    const categoryResponse = await callClaude(apiKey, categoryPrompt);
    
    const catMatch = categoryResponse.match(/Categoria:\s*(.+)/);
    const toneMatch = categoryResponse.match(/Tone:\s*(.+)/);
    
    const category = catMatch ? catMatch[1].trim() : "Richiesta informazioni";
    const tone = toneMatch ? toneMatch[1].trim() : "Neutro";

    // Step 2: Generazione risposte
    const responsePrompt = `Sei Filippo, gestore di BAYS (affittacamere a Civitanova Marche).

KNOWLEDGE BASE:
${JSON.stringify(KNOWLEDGE_BASE, null, 2)}

TONE DI VOICE: Caldo, responsabile, professionale, umano. Proteggo l'azienda al 100% senza scuse. Riconosco i problemi del cliente ma non faccio promesse impossibili. Veloce nella formulazione, soluzioni concrete.

Email ricevuta:
From: ${from}
Subject: ${subject}
Body: ${body}

Categoria: ${category}
Tone cliente: ${tone}

Genera 3 risposte email perfette, ognuna leggermente diversa nello stile ma tutte certificate, professionali e coerenti col tone di BAYS. 

Formato risposta:
---RISPOSTA 1---
[testo della risposta]
---RISPOSTA 2---
[testo della risposta]
---RISPOSTA 3---
[testo della risposta]`;

    const responsesText = await callClaude(apiKey, responsePrompt);
    
    const respMatches = responsesText.split(/---RISPOSTA \d+---/);
    const responses = respMatches
      .slice(1, 4)
      .map(r => r.trim())
      .filter(r => r.length > 0);

    if (responses.length < 3) {
      responses.push("Risposta non generata correttamente");
    }

    return res.status(200).json({
      category,
      tone,
      responses: responses.slice(0, 3)
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function callClaude(apiKey, message) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 2000,
      messages: [
        { role: "user", content: message }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "API Error");
  }

  const data = await response.json();
  return data.content[0].text;
}

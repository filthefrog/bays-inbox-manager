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
  const prompt = `Analizza questa email e categorizzala + genera 3 risposte.

Email:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

Rispondi SOLO con JSON:
{
  "category": "una tra: Lamentela, Prenotazione, Problema tecnico, Fatturazione, Richiesta informazioni, Complimento, Cancellazione",
  "tone": "una tra: Cortese, Neutro, Urgente, Arrabbiato",
  "response1": "prima risposta email",
  "response2": "seconda risposta email",
  "response3": "terza risposta email"
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
      max_tokens: 1200,
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
    responses: [
      parsed.response1 || "Risposta 1",
      parsed.response2 || "Risposta 2",
      parsed.response3 || "Risposta 3"
    ]
  };
}

export default async function handler(req, res) {
  const token = req.cookies.gmail_token;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const apiKey = req.headers['x-claude-key'];
  if (!apiKey) {
    return res.status(400).json({ error: "Claude API key required" });
  }

  try {
    const listResponse = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/messages?q=is:inbox&maxResults=8",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!listResponse.ok) {
      const detail = await listResponse.text();
      return res.status(listResponse.status === 401 ? 401 : 502).json({
        error: "Gmail list fetch failed: " + detail.slice(0, 200)
      });
    }

    const listData = await listResponse.json();
    const messageIds = listData.messages || [];

    if (messageIds.length === 0) {
      return res.status(200).json({ byCategory: {}, totalEmails: 0 });
    }

    const detailResults = await Promise.allSettled(
      messageIds.map(async (msg) => {
        const detailResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!detailResponse.ok) throw new Error("detail fetch failed");
        const detail = await detailResponse.json();
        const headers = detail.payload.headers;
        return {
          id: msg.id,
          from: headers.find(h => h.name === "From")?.value || "Unknown",
          subject: headers.find(h => h.name === "Subject")?.value || "(No subject)",
          body: extractBody(detail.payload)
        };
      })
    );

    const emails = detailResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    const analyzedResults = await Promise.allSettled(
      emails.map(email => analyzeAndRespond(email, apiKey))
    );

    const analyzedEmails = analyzedResults.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // Fallback: keep email visible even if Claude analysis failed
      return {
        ...emails[i],
        category: "Richiesta informazioni",
        tone: "Neutro",
        responses: ["Analisi non riuscita, riprova dalla scheda email."],
        analysisError: true
      };
    });

    const byCategory = {};
    analyzedEmails.forEach(email => {
      if (!byCategory[email.category]) byCategory[email.category] = [];
      byCategory[email.category].push(email);
    });

    return res.status(200).json({
      byCategory,
      totalEmails: analyzedEmails.length,
      failedCount: analyzedResults.filter(r => r.status === 'rejected').length
    });

  } catch (error) {
    console.error('Fatal error:', error);
    return res.status(500).json({ error: error.message || "Errore sconosciuto" });
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
    ...email,
    category: parsed.category || "Richiesta informazioni",
    tone: parsed.tone || "Neutro",
    responses: [
      parsed.response1 || "Risposta 1",
      parsed.response2 || "Risposta 2",
      parsed.response3 || "Risposta 3"
    ]
  };
}

function extractBody(payload) {
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart && textPart.body.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8").slice(0, 300);
    }
  }
  if (payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8").slice(0, 300);
  }
  return "(No body)";
}

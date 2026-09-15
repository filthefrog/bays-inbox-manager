export default async function handler(req, res) {
  const token = req.cookies.gmail_token;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const apiKey = req.headers['x-claude-key'];
  if (!apiKey) {
    return res.status(400).json({ error: "Claude API key required" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const hasCache = !!(SUPABASE_URL && SUPABASE_KEY);

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

    // Fetch dettagli email da Gmail
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

    // Controlla quali email sono già in cache
    let cached = {};
    if (hasCache) {
      const ids = emails.map(e => e.id).join(',');
      const cacheResp = await fetch(
        `${SUPABASE_URL}/rest/v1/analyzed_emails?id=in.(${ids})&select=*`,
        {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`
          }
        }
      );
      if (cacheResp.ok) {
        const rows = await cacheResp.json();
        rows.forEach(row => { cached[row.id] = row; });
      }
    }

    // Analizza solo le email NON in cache
    const toAnalyze = emails.filter(e => !cached[e.id]);
    const newlyAnalyzed = await Promise.allSettled(
      toAnalyze.map(email => analyzeAndRespond(email, apiKey))
    );

    const newResults = {};
    toAnalyze.forEach((email, i) => {
      const r = newlyAnalyzed[i];
      if (r.status === 'fulfilled') {
        newResults[email.id] = { ...r.value, id: email.id, resolved: false };
      } else {
        newResults[email.id] = {
          id: email.id,
          category: "Richiesta informazioni",
          tone: "Neutro",
          responses: ["Analisi non riuscita: " + (r.reason?.message || 'motivo sconosciuto')],
          analysisError: true,
          resolved: false
        };
      }
    });

    // Salva le nuove analisi in cache (solo quelle riuscite)
    if (hasCache) {
      const toSave = Object.entries(newResults)
        .filter(([id, v]) => !v.analysisError)
        .map(([id, v]) => ({
          id,
          category: v.category,
          tone: v.tone,
          responses: v.responses,
          resolved: false
        }));
      if (toSave.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/analyzed_emails`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates'
          },
          body: JSON.stringify(toSave)
        }).catch(() => {}); // non bloccare la risposta se il salvataggio fallisce
      }
    }

    // Combina: email con dettagli freschi da Gmail + categoria/risposte da cache o nuove
    const analyzedEmails = emails.map(email => {
      const analysis = cached[email.id] || newResults[email.id];
      return { ...email, ...analysis };
    });

    const byCategory = {};
    analyzedEmails.forEach(email => {
      if (!byCategory[email.category]) byCategory[email.category] = [];
      byCategory[email.category].push(email);
    });

    return res.status(200).json({
      byCategory,
      totalEmails: analyzedEmails.length,
      fromCache: Object.keys(cached).length,
      newlyAnalyzed: toAnalyze.length,
      cacheEnabled: hasCache
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
      return Buffer.from(textPart.body.data, "base64").toString("utf-8").slice(0, 3000);
    }
  }
  if (payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8").slice(0, 3000);
  }
  return "(No body)";
}

import { getFreshAccessToken } from '../lib/gmail-token.js';
import { sendPushToAll } from '../lib/send-push.js';
import { analyzeAndRespond, extractBody } from '../lib/analyze-email.js';

// Endpoint pensato per essere richiamato da uno scheduler esterno (GitHub Actions)
// ogni 5 minuti. Fa il minimo indispensabile per restare economico:
// - analizza con Claude SOLO le email mai viste prima (stessa cache di sempre)
// - se non c'è nessuna email nuova, non chiama Claude nemmeno una volta
export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }
  if (!CLAUDE_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY mancante nelle variabili Vercel' });
  }

  try {
    // Recupera il refresh token Gmail salvato al login
    const tokenResp = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.gmail_refresh_token&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const tokenRows = tokenResp.ok ? await tokenResp.json() : [];
    const refreshToken = tokenRows[0]?.value;
    if (!refreshToken) {
      return res.status(200).json({ skipped: true, reason: 'Nessun account Gmail ancora collegato' });
    }

    let token;
    try {
      token = await getFreshAccessToken(refreshToken);
    } catch (err) {
      return res.status(200).json({ skipped: true, reason: 'Token Gmail scaduto, serve riconnettersi dall\'app' });
    }

    const listResponse = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/messages?q=" + encodeURIComponent("is:inbox -from:me") + "&maxResults=8",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!listResponse.ok) {
      return res.status(200).json({ skipped: true, reason: 'Gmail non raggiungibile in questo momento' });
    }

    const listData = await listResponse.json();
    const messageIds = listData.messages || [];
    if (messageIds.length === 0) {
      return res.status(200).json({ checked: 0, newlyAnalyzed: 0, urgent: 0 });
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
    const emails = detailResults.filter(r => r.status === 'fulfilled').map(r => r.value);

    // Stessa cache di sempre: analizza SOLO le email mai viste prima. Questo è
    // ciò che tiene il costo vicino allo zero — la maggior parte dei controlli
    // ogni 5 minuti non troverà nulla di nuovo e non chiamerà Claude.
    const ids = emails.map(e => e.id).join(',');
    const cacheResp = await fetch(`${SUPABASE_URL}/rest/v1/analyzed_emails?id=in.(${ids})&select=id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const cachedRows = cacheResp.ok ? await cacheResp.json() : [];
    const cachedIds = new Set(cachedRows.map(r => r.id));
    const toAnalyze = emails.filter(e => !cachedIds.has(e.id));

    if (toAnalyze.length === 0) {
      return res.status(200).json({ checked: emails.length, newlyAnalyzed: 0, urgent: 0 });
    }

    const results = await Promise.allSettled(toAnalyze.map(email => analyzeAndRespond(email, CLAUDE_KEY)));

    const toSave = [];
    const urgent = [];
    toAnalyze.forEach((email, i) => {
      const r = results[i];
      if (r.status !== 'fulfilled') return;
      const v = r.value;
      toSave.push({ id: email.id, category: v.category, tone: v.tone, discrepancy: v.discrepancy || null, responses: v.responses, resolved: false });
      if (v.tone === "Urgente" || v.tone === "Arrabbiato") {
        urgent.push({ ...email, ...v });
      }
    });

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
      }).catch(() => {});
    }

    if (urgent.length > 0) {
      await sendPushToAll({
        title: urgent.length === 1 ? "Email urgente ricevuta" : `${urgent.length} email urgenti ricevute`,
        body: urgent.length === 1
          ? `Da ${urgent[0].from.replace(/<.*>/, '').trim() || urgent[0].from}: ${urgent[0].subject}`
          : "Controlla la dashboard ACME appena puoi.",
        url: "/"
      }).catch(() => {});
    }

    return res.status(200).json({ checked: emails.length, newlyAnalyzed: toAnalyze.length, urgent: urgent.length });
  } catch (error) {
    console.error('Errore check-urgent:', error);
    return res.status(500).json({ error: error.message });
  }
}

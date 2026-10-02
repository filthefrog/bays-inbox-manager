import { getFreshAccessToken } from '../lib/gmail-token.js';
import { sendPushToAll } from '../lib/send-push.js';
import { analyzeAndRespond, extractBody } from '../lib/analyze-email.js';
import { LABEL_NAME } from './test-lab.js';

export default async function handler(req, res) {
  const refreshToken = req.cookies.gmail_refresh;
  if (!refreshToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  let token;
  try {
    token = await getFreshAccessToken(refreshToken);
  } catch (err) {
    return res.status(401).json({
      error: err.code === "REFRESH_EXPIRED" ? "Sessione scaduta, riconnetti Gmail" : "Errore nel rinnovo del token Gmail"
    });
  }

  const apiKey = req.headers['x-claude-key'];
  if (!apiKey) {
    return res.status(400).json({ error: "Claude API key required" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const hasCache = !!(SUPABASE_URL && SUPABASE_KEY);

  // Recupera gli id dei messaggi per una query Gmail. Non fatale: in caso di
  // errore ritorna lista vuota, così un problema su una delle due ricerche
  // non fa cadere l'intera dashboard.
  async function listMessageIds(query, maxResults) {
    try {
      const r = await fetch(
        "https://www.googleapis.com/gmail/v1/users/me/messages?q=" + encodeURIComponent(query) + "&maxResults=" + maxResults,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!r.ok) return { ok: false, ids: [], status: r.status, detail: (await r.text()).slice(0, 200) };
      const j = await r.json();
      return { ok: true, ids: (j.messages || []).map(m => m.id) };
    } catch (e) {
      return { ok: false, ids: [], status: 0, detail: e.message };
    }
  }

  try {
    // Due ricerche separate invece di una sola:
    // - la posta reale, come prima (esclude le tue mail e quelle di test)
    // - la posta di test, SEMPRE per etichetta Gmail "ACME-TEST" — non per
    //   "-from:me", che può escluderla a seconda di come Gmail classifica le
    //   mail inserite via API, e non in competizione con la posta reale per
    //   gli stessi 8 posti: altrimenti basta un po' di traffico vero perché
    //   le mail di prova spariscano dalla Dashboard senza nessun errore.
    const [real, test] = await Promise.all([
      listMessageIds(`is:inbox -from:me -label:${LABEL_NAME}`, 8),
      listMessageIds(`is:inbox label:${LABEL_NAME}`, 20)
    ]);

    if (!real.ok) {
      return res.status(real.status === 401 ? 401 : 502).json({
        error: "Gmail list fetch failed: " + real.detail
      });
    }
    // Se la ricerca per etichetta fallisce non blocchiamo la dashboard: la
    // posta reale resta comunque visibile, semplicemente quella di test non
    // compare in questo giro (succede ad es. se l'etichetta non esiste
    // ancora perché non è mai stata seminata nessuna mail di prova).

    const seenIds = new Set();
    const messageIds = [...real.ids, ...test.ids].filter(id => {
      if (seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (messageIds.length === 0) {
      return res.status(200).json({ byCategory: {}, totalEmails: 0 });
    }

    // Fetch dettagli email da Gmail
    const detailResults = await Promise.allSettled(
      messageIds.map(async (id) => {
        const detailResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!detailResponse.ok) throw new Error("detail fetch failed");
        const detail = await detailResponse.json();
        const headers = detail.payload.headers;
        return {
          id,
          from: headers.find(h => h.name === "From")?.value || "Unknown",
          subject: headers.find(h => h.name === "Subject")?.value || "(No subject)",
          date: headers.find(h => h.name === "Date")?.value || "",
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
          discrepancy: v.discrepancy || null,
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

    // Notifica push per le nuove email urgenti o arrabbiate (solo quelle appena
    // analizzate ora, non quelle già viste prima, per non ripetere l'avviso)
    const urgentNew = toAnalyze.filter(email => {
      const r = newResults[email.id];
      return r && !r.analysisError && (r.tone === "Urgente" || r.tone === "Arrabbiato");
    });
    if (urgentNew.length > 0) {
      await sendPushToAll({
        title: urgentNew.length === 1 ? "Email urgente ricevuta" : `${urgentNew.length} email urgenti ricevute`,
        body: urgentNew.length === 1
          ? `Da ${urgentNew[0].from.replace(/<.*>/, '').trim() || urgentNew[0].from}: ${urgentNew[0].subject}`
          : "Controlla la dashboard ACME appena puoi.",
        url: "/"
      }).catch(() => {});
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
      cacheEnabled: hasCache,
      testLabelOk: test.ok
    });

  } catch (error) {
    console.error('Fatal error:', error);
    return res.status(500).json({ error: error.message || "Errore sconosciuto" });
  }
}

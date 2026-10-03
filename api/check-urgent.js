import { getFreshAccessToken } from '../lib/gmail-token.js';
import { sendPushToAll } from '../lib/send-push.js';
import { analyzeAndRespond, extractBody } from '../lib/analyze-email.js';
import { getOccupied, occupiedText } from '../lib/availability.js';
import { romeDate } from '../lib/auth.js';
import { flushUsage } from '../lib/claude.js';

const MAX_NEW_PER_RUN = 8;

// Date occupate per i prossimi 12 mesi, come contesto per l'IA. Non fatale:
// se il calendario non si legge, l'analisi procede senza.
async function occupiedContext() {
  try {
    const today = romeDate();
    const { ranges } = await getOccupied({ from: today, to: romeDate(365) });
    return { today, occupied: ranges.length ? occupiedText(ranges) : '- nessuna data occupata nei prossimi 12 mesi' };
  } catch (e) { return {}; }
}


// Endpoint pensato per essere richiamato da uno scheduler esterno (GitHub Actions)
// ogni 5 minuti. Fa il minimo indispensabile per restare economico:
// - analizza con Claude SOLO le email mai viste prima (stessa cache di sempre)
// - se non c'è nessuna email nuova, non chiama Claude nemmeno una volta
// - una volta al giorno, dalle 14:00 ora italiana, controlla anche se ci
//   sono check-out in giornata e manda un promemoria push (indipendente da
//   Gmail: se Gmail ha un problema, questo controllo funziona comunque)

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

  // --- Promemoria check-out del giorno (dalle 14:00 ora italiana) ----------
  // Indipendente dal resto: gira anche se Gmail non è raggiungibile. Prima
  // scattava solo se il controllo cadeva tra le 14:00 e le 14:04, ma GitHub
  // Actions ritarda spesso i cron di parecchi minuti e il promemoria saltava.
  // Ora parte al primo controllo dopo le 14:00 e la data dell'ultimo invio
  // resta su Supabase, così arriva una volta sola al giorno.
  let checkoutReminder = { attempted: false, sent: 0 };
  try {
    const hourPart = Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome', hour: '2-digit', hour12: false
    }).format(new Date()));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    if (hourPart >= 14 && hourPart < 22) {
      const lastResp = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.checkout_reminder_date&select=value`, { headers });
      const lastRows = lastResp.ok ? await lastResp.json() : [];
      const alreadySent = lastResp.ok && lastRows[0] && lastRows[0].value === today;

      if (lastResp.ok && !alreadySent) {
        checkoutReminder.attempted = true;
        const bookingsResp = await fetch(
          `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=guest_name,code&check_out=eq.${today}&status=neq.cancellata&status=neq.conclusa`,
          { headers }
        );
        if (bookingsResp.ok) {
          const checkoutsToday = await bookingsResp.json();
          if (checkoutsToday.length > 0) {
            await sendPushToAll({
              title: checkoutsToday.length === 1
                ? `Check-out oggi: ${checkoutsToday[0].guest_name}`
                : `${checkoutsToday.length} check-out oggi`,
              body: checkoutsToday.map(b => `${b.guest_name}${b.code ? ' (' + b.code + ')' : ''}`).join(', '),
              url: '/'
            }).catch(() => {});
            checkoutReminder.sent = checkoutsToday.length;
          }
          await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify({ id: 'checkout_reminder_date', value: today })
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Errore promemoria check-out:', err);
  }

  // --- Analisi email + push per le urgenti ----------------------------------
  try {
    // Recupera il refresh token Gmail salvato al login
    const tokenResp = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.gmail_refresh_token&select=value`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const tokenRows = tokenResp.ok ? await tokenResp.json() : [];
    const refreshToken = tokenRows[0]?.value;

    if (!refreshToken) {
      return res.status(200).json({ skipped: true, reason: 'Nessun account Gmail ancora collegato', checkoutReminder });
    }

    let token;
    try {
      token = await getFreshAccessToken(refreshToken);
    } catch (err) {
      // Prima il controllo si fermava in silenzio: niente più analisi né
      // notifiche urgenti finché non si riapriva l'app. Ora arriva un avviso,
      // al massimo uno al giorno. Solo per un rifiuto vero di Google, non per
      // un problema di rete momentaneo.
      let alerted = false;
      if (err.code === 'REFRESH_EXPIRED') {
        try {
          const today = romeDate();
          const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
          const r = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.gmail_alert_date&select=value`, { headers: h });
          const rows = r.ok ? await r.json() : [];
          if (r.ok && (!rows[0] || rows[0].value !== today)) {
            await sendPushToAll({
              title: 'Gmail scollegato',
              body: 'ACME non riesce più a leggere la posta: apri l\'app e tocca Riconnetti Gmail.',
              url: '/'
            }).catch(() => {});
            await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
              method: 'POST',
              headers: { ...h, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ id: 'gmail_alert_date', value: today })
            }).catch(() => {});
            alerted = true;
          }
        } catch (e) {}
      }
      return res.status(200).json({ skipped: true, reason: 'Token Gmail scaduto, serve riconnettersi dall\'app', alerted, checkoutReminder });
    }

    const listResponse = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/messages?q=" + encodeURIComponent("is:inbox -from:me -category:promotions -category:social") + "&maxResults=25",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!listResponse.ok) {
      return res.status(200).json({ skipped: true, reason: 'Gmail non raggiungibile in questo momento', checkoutReminder });
    }

    const listData = await listResponse.json();
    const messageIds = listData.messages || [];

    if (messageIds.length === 0) {
      return res.status(200).json({ checked: 0, newlyAnalyzed: 0, urgent: 0, checkoutReminder });
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
    const cacheResp = await fetch(`${SUPABASE_URL}/rest/v1/analyzed_emails?id=in.(${ids})&select=id,resolved`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const cachedRows = cacheResp.ok ? await cacheResp.json() : [];
    const cachedIds = new Set(cachedRows.map(r => r.id));

    const toAnalyze = emails.filter(e => !cachedIds.has(e.id)).slice(0, MAX_NEW_PER_RUN);

    if (toAnalyze.length === 0) {
      return res.status(200).json({ checked: emails.length, newlyAnalyzed: 0, urgent: 0, checkoutReminder });
    }

    const context = await occupiedContext();
    const results = await Promise.allSettled(toAnalyze.map(email => analyzeAndRespond(email, CLAUDE_KEY, context)));
    await flushUsage();

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

    // Notifica per ogni giro con email nuove (non solo le urgenti), con il
    // numero da mostrare sull'icona dell'app: su iPhone un'app web non può
    // aggiornarsi da sola a schermo spento, quindi è il server a lavorare
    // ogni 5 minuti e ad avvisare; aprendo l'app le email sono già pronte.
    let notified = null;
    if (toSave.length > 0) {
      const badge = cachedRows.filter(r => !r.resolved).length + toSave.length;
      const saved = toAnalyze.filter((e, i) => results[i].status === 'fulfilled');
      const who = (e) => `${e.from.replace(/<.*>/, '').replace(/"/g, '').trim() || e.from}: ${e.subject}`;
      const first = urgent[0] || saved[0];
      await sendPushToAll({
        title: urgent.length
          ? (urgent.length === 1 ? 'Email urgente ricevuta' : `${urgent.length} email urgenti ricevute`)
          : (saved.length === 1 ? 'Nuova email' : `${saved.length} nuove email`),
        body: `Da ${who(first)}${saved.length > 1 ? ` e altre ${saved.length - 1}` : ''}`,
        url: '/',
        badge
      }).catch(() => {});
      notified = { count: saved.length, urgent: urgent.length, badge };
    }

    return res.status(200).json({ checked: emails.length, newlyAnalyzed: toAnalyze.length, urgent: urgent.length, notified, checkoutReminder });

  } catch (error) {
    console.error('Errore check-urgent:', error);
    return res.status(500).json({ error: error.message, checkoutReminder });
  }
}

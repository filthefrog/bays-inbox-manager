import webpush from 'web-push';

// Promemoria giornaliero (circa alle 14:00 ora italiana, tramite Vercel Cron)
// per le prenotazioni il cui check-out è OGGI e non sono già concluse/cancellate.
// Legge le iscrizioni push dalla stessa tabella "push_subscriptions" popolata
// da /api/push-subscription.js: id = endpoint, subscription = oggetto JSON
// completo (endpoint + keys.p256dh + keys.auth).

export default async function handler(req, res) {
  // Protezione: se imposti la variabile d'ambiente CRON_SECRET su Vercel,
  // verifica che la chiamata arrivi davvero dal Cron e non da chiunque trovi l'URL.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Non autorizzato' });
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'Chiavi VAPID non configurate (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)' });
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@domus106.it',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    // "Oggi" nel fuso orario italiano, non UTC (il server di Vercel gira in UTC)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());

    const bookingsResp = await fetch(
      `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=*&check_out=eq.${today}&status=neq.cancellata&status=neq.conclusa`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const bookings = bookingsResp.ok ? await bookingsResp.json() : [];

    if (bookings.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, message: 'Nessun check-out oggi' });
    }

    const subsResp = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,subscription`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const rows = subsResp.ok ? await subsResp.json() : [];

    const title = bookings.length === 1
      ? `Check-out oggi: ${bookings[0].guest_name}`
      : `${bookings.length} check-out oggi`;
    const body = bookings.map(b => `${b.guest_name}${b.code ? ' (' + b.code + ')' : ''}`).join(', ');

    let sent = 0;
    for (const row of rows) {
      const pushSubscription = row.subscription;
      if (!pushSubscription || !pushSubscription.endpoint) continue;
      try {
        await webpush.sendNotification(pushSubscription, JSON.stringify({ title, body, url: '/' }));
        sent++;
      } catch (err) {
        // Subscription non più valida (utente ha disinstallato/revocato): la rimuoviamo
        // per non ritentare in eterno su un endpoint morto. Stesso schema di cancellazione
        // usato da /api/push-subscription.js (id = endpoint).
        if (err.statusCode === 410 || err.statusCode === 404) {
          await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'DELETE',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          }).catch(() => {});
        }
      }
    }

    return res.status(200).json({ ok: true, sent, bookings: bookings.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

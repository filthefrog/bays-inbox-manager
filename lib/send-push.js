import webpush from 'web-push';

// Chiave pubblica VAPID — non è un segreto, la usa anche il frontend per iscriversi
export const VAPID_PUBLIC_KEY = "BAUiDQRLOp24qASDBM3nbZp39PPaZdfaCSC0Fcx9u79ervwtSp7apDxmMo_aV-V-4qVXOH7wB4ck598mmBgJcSU";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(
    'mailto:filippomariaberio@gmail.com',
    VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  configured = true;
}

// Manda una notifica push a tutti i dispositivi iscritti (salvati su Supabase).
// Rimuove automaticamente le iscrizioni non più valide (dispositivo disconnesso/scaduto).
export async function sendPushToAll(payload) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY || !process.env.VAPID_PRIVATE_KEY) return;

  ensureConfigured();

  let rows = [];
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,subscription`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });
    if (!resp.ok) return;
    rows = await resp.json();
  } catch (err) {
    console.error('Errore lettura sottoscrizioni push:', err);
    return;
  }

  for (const row of rows) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(row.id)}`, {
          method: 'DELETE',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
        }).catch(() => {});
      } else {
        console.error('Errore invio push:', err.message);
      }
    }
  }
}

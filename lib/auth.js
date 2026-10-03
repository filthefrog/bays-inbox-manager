import { getFreshAccessToken } from './gmail-token.js';

// Controllo di accesso per gli endpoint che leggono o modificano dati privati
// (prenotazioni, email, notifiche). Vale come "utente" chi ha il cookie Gmail
// dell'app: il cookie deve coincidere con il refresh token salvato al login
// oppure, se non coincide (es. login da un altro telefono), Google deve
// accettarlo. Gli esiti positivi restano in memoria per qualche minuto, così
// le chiamate ravvicinate non interrogano Google ogni volta.
const validated = new Map(); // refresh token -> scadenza (ms)
const TTL_MS = 10 * 60 * 1000;

export async function isAuthorized(req) {
  const refresh = req.cookies && req.cookies.gmail_refresh;
  if (!refresh) return false;
  const until = validated.get(refresh);
  if (until && until > Date.now()) return true;

  let ok = false;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.gmail_refresh_token&select=value`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const rows = resp.ok ? await resp.json() : [];
      ok = !!rows[0] && rows[0].value === refresh;
    } catch (e) {}
  }
  if (!ok) {
    try {
      await getFreshAccessToken(refresh);
      ok = true;
    } catch (e) {}
  }
  if (ok) validated.set(refresh, Date.now() + TTL_MS);
  return ok;
}

// Risponde 401 e ritorna false se la richiesta non è autorizzata.
export async function requireAuth(req, res) {
  if (await isAuthorized(req)) return true;
  res.status(401).json({ error: 'Non autenticato: accedi con Gmail' });
  return false;
}

// Data di oggi (o tra N giorni) in ora italiana, formato AAAA-MM-GG. I server
// Vercel girano in UTC: senza questo, tra mezzanotte e le 2 "oggi" sarebbe ieri.
export function romeDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
}

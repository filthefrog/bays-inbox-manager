export default async function handler(req, res) {
  // Logout assorbito qui da api-logout.js (era 4 righe, non aveva senso come
  // funzione serverless a sé) — GET /api/auth?action=logout
  if (req.query.action === 'logout') {
    res.setHeader('Set-Cookie', [
      'gmail_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      'gmail_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
    ]);
    return res.status(200).json({ ok: true });
  }

  // Email della persona delle pulizie — salvata nella stessa tabella
  // app_state già usata per il refresh token Gmail (una riga per chiave).
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (req.query.action === 'get-cleaner-email') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(200).json({ cleanerEmail: null });
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/app_state?id=eq.cleaner_email&select=value`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const rows = resp.ok ? await resp.json() : [];
      return res.status(200).json({ cleanerEmail: rows[0]?.value || null });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST' && req.query.action === 'save-cleaner-email') {
    if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase non configurato' });
    const { cleanerEmail } = req.body || {};
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/app_state?on_conflict=id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates'
        },
        body: JSON.stringify({ id: 'cleaner_email', value: cleanerEmail || '' })
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "YOUR_CLIENT_ID";
  const REDIRECT_URI = process.env.REDIRECT_URI || "https://bays-inbox-manager.vercel.app/api/callback";
  const SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPE)}&access_type=offline&prompt=consent`;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(200).json({ authUrl });
}

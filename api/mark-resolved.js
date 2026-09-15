export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    // Se il database non è configurato, non è un errore bloccante
    return res.status(200).json({ ok: true, cacheEnabled: false });
  }

  const { emailId } = req.body;
  if (!emailId) {
    return res.status(400).json({ error: 'Missing emailId' });
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/analyzed_emails?id=eq.${emailId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ resolved: true })
      }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(detail.slice(0, 200));
    }
    return res.status(200).json({ ok: true, cacheEnabled: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

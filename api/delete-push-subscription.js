export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }

  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: 'endpoint mancante' });
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(endpoint)}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

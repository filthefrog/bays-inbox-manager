// Endpoint per l'archivio interno delle prenotazioni confermate.
// GET  -> elenco prenotazioni (per la sezione "Prenotazioni confermate")
// POST -> salva una nuova prenotazione confermata
// DELETE -> rimuove una prenotazione (es. se poi viene cancellata)
export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }

  if (req.method === 'GET') {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings?select=*&order=check_in.asc`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const rows = resp.ok ? await resp.json() : [];
      return res.status(200).json({ bookings: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { guestName, guestEmail, checkIn, checkOut, total } = req.body;
    if (!guestName || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'Nome ospite, check-in e check-out sono obbligatori' });
    }
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          guest_name: guestName,
          guest_email: guestEmail || null,
          check_in: checkIn,
          check_out: checkOut,
          total: total || null
        })
      });
      if (!resp.ok) {
        const detail = await resp.text();
        return res.status(500).json({ error: 'Errore Supabase: ' + detail.slice(0, 200) });
      }
      const created = await resp.json();
      return res.status(200).json({ success: true, booking: created[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id mancante' });
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Endpoint per l'archivio interno delle prenotazioni confermate.
// GET    -> elenco prenotazioni (o una singola, passando ?code=XXX)
// POST   -> salva una nuova prenotazione confermata (genera un codice univoco)
// PATCH  -> aggiorna stato/note di una prenotazione esistente
// DELETE -> rimuove una prenotazione (es. se poi viene cancellata)

function generateBookingCode(checkInStr) {
  // Formato: D106-MMDD-XXXX — leggibile, comunicabile a voce, nessun contatore
  // condiviso da sincronizzare (evita collisioni tra richieste simultanee).
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // esclude 0/O/1/I: ambigui a voce
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += CHARS[Math.floor(Math.random() * CHARS.length)];
  const d = new Date((checkInStr || new Date().toISOString().slice(0, 10)) + 'T00:00:00');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `D106-${mm}${dd}-${suffix}`;
}

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }

  // Genera l'evento .ics per il Calendario del telefono, come vera risposta
  // HTTP (Content-Type: text/calendar) — assorbito qui da booking-ics.js per
  // restare sotto il limite di funzioni serverless del piano Hobby.
  if (req.method === 'GET' && req.query.ics === '1') {
    const { guestName, checkIn, checkOut, guestEmail, total, guests, paymentStatus, notes, code } = req.query;
    if (!guestName || !checkIn || !checkOut) {
      return res.status(400).send('Dati mancanti per generare l\'evento (nome ospite, check-in e check-out sono obbligatori)');
    }
    const fmtDate = (d) => (d || '').replace(/-/g, '');
    const uid = `acme-${checkIn}-${guestName.replace(/\s+/g, '')}-${Date.now()}@domus106`;
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const paymentLabel = paymentStatus === 'saldata' ? 'Saldata'
      : paymentStatus === 'acconto versato' ? 'Acconto versato' : 'DA SALDARE';
    const paymentBadge = paymentStatus === 'saldata' ? '✅' : (paymentStatus === 'acconto versato' ? '💶' : '⚠️');
    const descParts = [];
    descParts.push('Pagamento: ' + paymentLabel);
    if (guests) descParts.push('Ospiti: ' + guests);
    if (guestEmail) descParts.push('Email ospite: ' + guestEmail);
    if (total) descParts.push('Totale: € ' + Number(total).toFixed(2));
    if (code) descParts.push('Codice: ' + code);
    if (notes) descParts.push('Note: ' + notes);
    descParts.push('Creato da ACME Inbox Manager');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Domus 106//ACME//IT', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${fmtDate(checkIn)}`, `DTEND;VALUE=DATE:${fmtDate(checkOut)}`,
      `SUMMARY:${paymentBadge} ${guestName} — Domus 106 (${paymentLabel})`,
      `DESCRIPTION:${descParts.join('\\n')}`,
      'END:VEVENT', 'END:VCALENDAR'
    ];
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prenotazione.ics"');
    return res.status(200).send(lines.join('\r\n'));
  }

  if (req.method === 'GET') {
    try {
      const { code, needsReview, guestEmail } = req.query || {};
      let path;
      if (code) {
        path = `confirmed_bookings?select=*&code=eq.${encodeURIComponent(code)}`;
      } else if (needsReview === 'true') {
        // Prenotazioni il cui check-out è arrivato (oggi o prima), non ancora
        // rivisitate e non cancellate — usate per il pop-up "Com'è andato il
        // soggiorno?" che compare all'apertura dell'app.
        const today = new Date().toISOString().slice(0, 10);
        path = `confirmed_bookings?select=*&check_out=lte.${today}&status=neq.cancellata&or=(checkout_reviewed.is.null,checkout_reviewed.eq.false)&order=check_out.asc`;
      } else if (guestEmail) {
        // Storico dell'ospite: soggiorni precedenti con questa email, i più
        // recenti prima — usato per avvisare se un ospite che ha già dato
        // problemi in passato sta prenotando di nuovo.
        path = `confirmed_bookings?select=*&guest_email=eq.${encodeURIComponent(guestEmail)}&order=check_out.desc&limit=5`;
      } else {
        path = `confirmed_bookings?select=*&order=check_in.asc`;
      }
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      const rows = resp.ok ? await resp.json() : [];
      return res.status(200).json({ bookings: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const {
      guestName, guestEmail, checkIn, checkOut, total,
      sourceFrom, sourceSubject, sourceBody, notes, guests, paymentStatus,
      ratePerNight, discountPercent
    } = req.body;
    if (!guestName || !checkIn || !checkOut) {
      return res.status(400).json({ error: 'Nome ospite, check-in e check-out sono obbligatori' });
    }

    // Prova a inserire con un codice generato; in caso di rarissima collisione
    // (violazione del vincolo unique) rigenera e riprova, fino a 3 volte.
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateBookingCode(checkIn);
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
            code,
            guest_name: guestName,
            guest_email: guestEmail || null,
            check_in: checkIn,
            check_out: checkOut,
            total: total || null,
            status: 'confermata',
            notes: notes || null,
            guests: guests || null,
            payment_status: paymentStatus || 'da saldare',
            rate_per_night: ratePerNight || null,
            discount_percent: discountPercent || null,
            source_from: sourceFrom || null,
            source_subject: sourceSubject || null,
            source_body: sourceBody || null
          })
        });
        if (resp.ok) {
          const created = await resp.json();
          return res.status(200).json({ success: true, booking: created[0] });
        }
        const detail = await resp.text();
        if (detail.includes('duplicate key') || detail.toLowerCase().includes('code')) {
          lastError = detail;
          continue; // collisione sul codice: rigenera e riprova
        }
        return res.status(500).json({ error: 'Errore Supabase: ' + detail.slice(0, 200) });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    return res.status(500).json({ error: 'Impossibile generare un codice univoco: ' + (lastError || '').slice(0, 150) });
  }

  if (req.method === 'PATCH') {
    const { id, notes, status, checkoutReviewed, paymentStatus, concludedAt } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id mancante' });
    const patch = {};
    if (notes !== undefined) patch.notes = notes;
    if (status !== undefined) patch.status = status;
    if (checkoutReviewed !== undefined) patch.checkout_reviewed = checkoutReviewed;
    if (paymentStatus !== undefined) patch.payment_status = paymentStatus;
    if (concludedAt !== undefined) patch.concluded_at = concludedAt;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=representation'
        },
        body: JSON.stringify(patch)
      });
      if (!resp.ok) {
        const detail = await resp.text();
        return res.status(500).json({ error: 'Errore Supabase: ' + detail.slice(0, 200) });
      }
      const updated = await resp.json();
      return res.status(200).json({ success: true, booking: updated[0] });
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

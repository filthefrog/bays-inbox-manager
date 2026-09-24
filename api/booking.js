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

  // Preventivo "in sospeso" collegato a un'email ospite — salvato quando si
  // invia un preventivo, letto quando si riapre una mail successiva dello
  // stesso cliente, per precompilare la sezione Prenotazione senza dover
  // ridigitare tariffa/sconto/date già decisi in precedenza.
  if (req.method === 'GET' && req.query.pendingQuoteEmail) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/pending_quotes?select=*&guest_email=eq.${encodeURIComponent(req.query.pendingQuoteEmail)}&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = resp.ok ? await resp.json() : [];
      return res.status(200).json({ pendingQuote: rows[0] || null });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Promemoria operativi: pulizie da confermare (mail mandata alla colf ma
  // mai confermata da Filippo) e pagamenti da sollecitare (ancora "da
  // saldare" con check-in vicino o già passato).
  if (req.method === 'GET' && req.query.reminders === '1') {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const soon = new Date();
      soon.setDate(soon.getDate() + 2);
      const soonStr = soon.toISOString().slice(0, 10);

      const cleanerResp = await fetch(
        `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=id,guest_name,check_out,code&status=eq.conclusa&cleaner_notified=eq.true&cleaner_confirmed=eq.false&order=check_out.desc`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const paymentResp = await fetch(
        `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=id,guest_name,check_in,code&payment_status=eq.da saldare&status=neq.cancellata&status=neq.conclusa&check_in=lte.${soonStr}&order=check_in.asc`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );

      let cleanerPending = cleanerResp.ok ? await cleanerResp.json() : [];

      // Per ogni pulizia da confermare, aggiungo la prossima prenotazione
      // reale — così il promemoria dice "check-in di [nome] il [data]",
      // non solo "qualcuno non ha confermato".
      cleanerPending = await Promise.all(cleanerPending.map(async (b) => {
        try {
          const nextResp = await fetch(
            `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=guest_name,check_in&check_in=gte.${b.check_out}&status=neq.cancellata&status=neq.conclusa&order=check_in.asc&limit=1`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
          );
          const nextRows = nextResp.ok ? await nextResp.json() : [];
          const next = nextRows[0];
          return { ...b, next_check_in: next?.check_in || null, next_guest_name: next?.guest_name || null };
        } catch (e) {
          return { ...b, next_check_in: null, next_guest_name: null };
        }
      }));

      return res.status(200).json({
        cleanerPending,
        paymentPending: paymentResp.ok ? await paymentResp.json() : []
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Prossima prenotazione dopo una certa data — usata per avvisare la colf
  // di quanto tempo ha per le pulizie dopo un check-out.
  if (req.method === 'GET' && req.query.nextCheckinAfter) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=guest_name,check_in,check_out&check_in=gte.${encodeURIComponent(req.query.nextCheckinAfter)}&status=neq.cancellata&status=neq.conclusa&order=check_in.asc&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = resp.ok ? await resp.json() : [];
      return res.status(200).json({ nextBooking: rows[0] || null });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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

  // Salva (o aggiorna) il preventivo "in sospeso" per questo cliente — una
  // riga sola per guest_email, sovrascritta ogni volta che si invia un nuovo
  // preventivo.
  if (req.method === 'POST' && req.body && req.body.savePendingQuote) {
    const { guestEmail, guestName, checkIn, checkOut, ratePerNight, discountPercent, guests, total, sourceSubject } = req.body;
    if (!guestEmail) return res.status(400).json({ error: 'guestEmail mancante' });
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/pending_quotes?on_conflict=guest_email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify({
          guest_email: guestEmail,
          guest_name: guestName || null,
          check_in: checkIn || null,
          check_out: checkOut || null,
          rate_per_night: ratePerNight || null,
          discount_percent: discountPercent || null,
          guests: guests || null,
          total: total || null,
          source_subject: sourceSubject || null,
          created_at: new Date().toISOString()
        })
      });
      if (!resp.ok) {
        const detail = await resp.text();
        return res.status(500).json({ error: 'Errore Supabase: ' + detail.slice(0, 200) });
      }
      const created = await resp.json();
      return res.status(200).json({ success: true, pendingQuote: created[0] });
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
    const { id, notes, status, checkoutReviewed, paymentStatus, concludedAt, cleanerNotified, cleanerConfirmed } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id mancante' });
    const patch = {};
    if (notes !== undefined) patch.notes = notes;
    if (status !== undefined) patch.status = status;
    if (checkoutReviewed !== undefined) patch.checkout_reviewed = checkoutReviewed;
    if (paymentStatus !== undefined) patch.payment_status = paymentStatus;
    if (concludedAt !== undefined) patch.concluded_at = concludedAt;
    if (cleanerNotified !== undefined) patch.cleaner_notified = cleanerNotified;
    if (cleanerConfirmed !== undefined) patch.cleaner_confirmed = cleanerConfirmed;
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

  // Ripulisce il preventivo in sospeso una volta che la prenotazione è stata
  // confermata per davvero — altrimenti riapparirebbe precompilato anche su
  // un soggiorno futuro non collegato.
  if (req.method === 'DELETE' && req.body && req.body.deletePendingQuoteEmail) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/pending_quotes?guest_email=eq.${encodeURIComponent(req.body.deletePendingQuoteEmail)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      return res.status(200).json({ success: true });
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

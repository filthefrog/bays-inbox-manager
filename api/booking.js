// Endpoint per l'archivio interno delle prenotazioni confermate.
// GET    -> elenco prenotazioni (o una singola, passando ?code=XXX)
// POST   -> salva una nuova prenotazione confermata (genera un codice univoco)
// PATCH  -> aggiorna stato/note di una prenotazione esistente
// DELETE -> rimuove una prenotazione (es. se poi viene cancellata)

import { requireAuth, romeDate } from '../lib/auth.js';
import { getOccupied, conflictsWith, getIcalSources, stateGet, stateSet, buildFeed } from '../lib/availability.js';
import crypto from 'crypto';

// Testo sicuro per un campo .ics (RFC 5545): niente a capo, virgole o punti e
// virgola "nudi", altrimenti il Calendario scarta o tronca l'evento.
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);

// Colonne aggiunte dopo (vedi supabase/2026-10-camere-pagamenti.sql). Finché
// non sono state create nel database, si salva senza: l'app funziona lo
// stesso e la risposta lo segnala con schemaMissing.
const NEW_COLUMNS = ['rooms', 'amount_paid'];
async function writeWithFallback(url, init, row) {
  let resp = await fetch(url, { ...init, body: JSON.stringify(row) });
  if (resp.ok) return { resp, schemaMissing: false };
  const detail = await resp.text();
  const missing = detail.includes('PGRST204') && NEW_COLUMNS.some(c => detail.includes(`'${c}'`));
  if (!missing) return { resp, detail, schemaMissing: false };
  const slim = { ...row };
  NEW_COLUMNS.forEach(c => delete slim[c]);
  if (Object.keys(slim).length === 0) return { resp, detail, schemaMissing: true };
  resp = await fetch(url, { ...init, body: JSON.stringify(slim) });
  return { resp, detail: resp.ok ? null : await resp.text(), schemaMissing: true };
}

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
    const uid = `acme-${checkIn}-${guestName.replace(/[^A-Za-z0-9]+/g, '')}-${Date.now()}@domus106`;
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
    // L'evento si genera solo dai parametri della richiesta: non legge dati
    // salvati, per questo resta accessibile senza login (l'apertura dal
    // Calendario del telefono non porta con sé i cookie dell'app).
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Domus 106//ACME//IT', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${fmtDate(checkIn)}`, `DTEND;VALUE=DATE:${fmtDate(checkOut)}`,
      `SUMMARY:${icsText(`${paymentBadge} ${guestName} — Domus 106 (${paymentLabel})`)}`,
      `DESCRIPTION:${descParts.map(icsText).join('\\n')}`,
      'END:VEVENT', 'END:VCALENDAR'
    ];
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="prenotazione.ics"');
    return res.status(200).send(lines.join('\r\n'));
  }

  // Feed iCal delle prenotazioni dirette per Booking e Airbnb. Pubblico perché
  // i portali lo leggono da soli, ma protetto da un codice segreto nel link e
  // senza nomi né dati degli ospiti (solo le date occupate).
  if (req.method === 'GET' && req.query.feed) {
    const token = await stateGet('ical_feed_token');
    if (!token || req.query.feed !== token) return res.status(404).send('Calendario non trovato');
    const from = romeDate(-60);
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=id,check_in,check_out&status=neq.cancellata&check_out=gte.${from}&order=check_in.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!resp.ok) return res.status(502).send('Archivio non raggiungibile');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buildFeed(await resp.json()));
  }

  // Tutto il resto legge o modifica le prenotazioni: solo per chi ha fatto login.
  if (!(await requireAuth(req, res))) return;

  // Disponibilità: soggiorni (ACME, Booking, Airbnb) che si sovrappongono alle date
  if (req.method === 'GET' && req.query.availability === '1') {
    const { checkIn, checkOut, excludeId } = req.query;
    if (!checkIn || !checkOut || checkOut <= checkIn) return res.status(400).json({ error: 'Date non valide' });
    const { ranges, errors, checked } = await getOccupied({ from: checkIn, to: checkOut, excludeBookingId: excludeId });
    return res.status(200).json({ conflicts: conflictsWith(ranges, checkIn, checkOut), errors, checked });
  }

  // Operazioni per soggiorno: email agli ospiti già inviate, comunicazioni
  // Alloggiati Web già fatte, informazioni pratiche per gli ospiti. Tutto in
  // app_state (nessuna colonna nuova da creare nel database).
  const OPS_KEYS = { guestMail: 'guest_mails_sent', alloggiati: 'alloggiati_sent' };
  const readJson = async (id) => { try { return JSON.parse((await stateGet(id)) || '{}'); } catch (e) { return {}; } };
  if (req.method === 'GET' && req.query.opsState === '1') {
    const [guestMails, alloggiati, guestInfo] = await Promise.all([readJson('guest_mails_sent'), readJson('alloggiati_sent'), readJson('guest_info')]);
    return res.status(200).json({ guestMails, alloggiati, guestInfo });
  }
  if (req.method === 'POST' && req.body && req.body.markOps) {
    const { kind, key, done } = req.body.markOps;
    const id = OPS_KEYS[kind];
    if (!id || !key || typeof key !== 'string' || key.length > 80) return res.status(400).json({ error: 'Operazione non valida' });
    try {
      const map = await readJson(id);
      if (done === false) delete map[key]; else map[key] = new Date().toISOString();
      // Tiene solo gli ultimi 500 segni, i più recenti
      const keys = Object.keys(map);
      if (keys.length > 500) keys.sort((a, b) => map[a].localeCompare(map[b])).slice(0, keys.length - 500).forEach(k => delete map[k]);
      await stateSet(id, JSON.stringify(map));
      return res.status(200).json({ success: true, map });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (req.method === 'POST' && req.body && req.body.saveGuestInfo) {
    const src = req.body.saveGuestInfo || {};
    const clean = {};
    ['wifiName', 'wifiPassword', 'arrivalInfo', 'iban', 'ibanHolder'].forEach(k => { clean[k] = String(src[k] || '').slice(0, 2000); });
    try {
      await stateSet('guest_info', JSON.stringify(clean));
      return res.status(200).json({ success: true, guestInfo: clean });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Il database ha già le colonne nuove (camere, incassato)?
  if (req.method === 'GET' && req.query.schemaCheck === '1') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings?select=rooms,amount_paid&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const r2 = await fetch(`${SUPABASE_URL}/rest/v1/pending_quotes?select=rooms&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return res.status(200).json({ upToDate: r.ok && r2.ok });
  }

  // Impostazioni dei calendari: link iCal da importare e link da esportare
  if (req.method === 'GET' && req.query.calendarSettings === '1') {
    let token = await stateGet('ical_feed_token');
    if (!token) { token = crypto.randomBytes(18).toString('base64url'); await stateSet('ical_feed_token', token); }
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const sources = await getIcalSources();
    return res.status(200).json({
      booking: sources.booking || '', airbnb: sources.airbnb || '',
      feedUrl: `https://${host}/api/booking?feed=${token}`
    });
  }
  if (req.method === 'POST' && req.body && req.body.saveCalendarSettings) {
    const clean = (u) => {
      const v = String(u || '').trim().replace(/^webcal:\/\//i, 'https://');
      if (v && !/^https:\/\/[^\s]+$/i.test(v)) throw new Error('Il link deve iniziare con https://');
      return v;
    };
    try {
      await stateSet('ical_import', JSON.stringify({ booking: clean(req.body.booking), airbnb: clean(req.body.airbnb) }));
      const { errors } = await getOccupied({ from: romeDate(), to: romeDate(400) });
      return res.status(200).json({ success: true, errors });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
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
  // mai confermata da Filippo) e pagamenti da sollecitare (non ancora saldati,
  // compresi quelli con solo l'acconto, con check-in vicino o già passato).
  if (req.method === 'GET' && req.query.reminders === '1') {
    try {
      const soonStr = romeDate(2);

      const cleanerResp = await fetch(
        `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=id,guest_name,check_out,code&status=eq.conclusa&cleaner_notified=eq.true&cleaner_confirmed=eq.false&order=check_out.desc`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const paymentResp = await fetch(
        `${SUPABASE_URL}/rest/v1/confirmed_bookings?select=*&payment_status=in.(${encodeURIComponent('"da saldare","acconto versato"')})&status=neq.cancellata&status=neq.conclusa&check_in=lte.${soonStr}&order=check_in.asc`,
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
        const today = romeDate();
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
    const { guestEmail, guestName, checkIn, checkOut, ratePerNight, discountPercent, guests, total, sourceSubject, rooms } = req.body;
    if (!guestEmail) return res.status(400).json({ error: 'guestEmail mancante' });
    try {
      const { resp, detail: pqDetail } = await writeWithFallback(`${SUPABASE_URL}/rest/v1/pending_quotes?on_conflict=guest_email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'resolution=merge-duplicates,return=representation'
        }
      }, {
          guest_email: guestEmail,
          guest_name: guestName || null,
          check_in: checkIn || null,
          check_out: checkOut || null,
          rate_per_night: ratePerNight || null,
          discount_percent: discountPercent || null,
          guests: guests || null,
          total: total || null,
          source_subject: sourceSubject || null,
          created_at: new Date().toISOString(),
          rooms: rooms ? Number(rooms) : null
        });
      if (!resp.ok) {
        return res.status(500).json({ error: 'Errore Supabase: ' + (pqDetail || await resp.text()).slice(0, 200) });
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
      ratePerNight, discountPercent, rooms, amountPaid
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
        const { resp, detail: firstDetail, schemaMissing } = await writeWithFallback(`${SUPABASE_URL}/rest/v1/confirmed_bookings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=representation'
          }
        }, {
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
            source_body: sourceBody || null,
            rooms: rooms ? Number(rooms) : null,
            amount_paid: amountPaid ? Number(amountPaid) : 0
          });
        if (resp.ok) {
          const created = await resp.json();
          return res.status(200).json({ success: true, booking: created[0], schemaMissing });
        }
        const detail = firstDetail || await resp.text();
        // 23505 = violazione di unicità (codice già usato). Prima bastava che
        // l'errore contenesse la parola "code" — cioè qualsiasi errore Supabase,
        // che riporta sempre un campo "code" — e ogni guasto diventava un finto
        // "impossibile generare un codice univoco".
        if (detail.includes('23505') || detail.includes('duplicate key')) {
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
    const { id, notes, status, checkoutReviewed, paymentStatus, concludedAt, cleanerNotified, cleanerConfirmed, rooms, amountPaid } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id mancante' });
    const patch = {};
    if (notes !== undefined) patch.notes = notes;
    if (status !== undefined) patch.status = status;
    if (checkoutReviewed !== undefined) patch.checkout_reviewed = checkoutReviewed;
    if (paymentStatus !== undefined) patch.payment_status = paymentStatus;
    if (concludedAt !== undefined) patch.concluded_at = concludedAt;
    if (cleanerNotified !== undefined) patch.cleaner_notified = cleanerNotified;
    if (cleanerConfirmed !== undefined) patch.cleaner_confirmed = cleanerConfirmed;
    if (rooms !== undefined) patch.rooms = rooms ? Number(rooms) : null;
    if (amountPaid !== undefined) patch.amount_paid = Number(amountPaid) || 0;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
    try {
      const { resp, detail, schemaMissing } = await writeWithFallback(`${SUPABASE_URL}/rest/v1/confirmed_bookings?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: 'return=representation'
        }
      }, patch);
      if (!resp.ok) {
        if (schemaMissing) return res.status(409).json({ error: 'Per salvare camere e importi incassati va prima aggiornato il database (vedi istruzioni)', schemaMissing });
        return res.status(500).json({ error: 'Errore Supabase: ' + (detail || await resp.text()).slice(0, 200) });
      }
      const updated = await resp.json();
      return res.status(200).json({ success: true, booking: updated[0], schemaMissing });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Ripulisce il preventivo in sospeso una volta che la prenotazione è stata
  // confermata per davvero — altrimenti riapparirebbe precompilato anche su
  // un soggiorno futuro non collegato.
  if (req.method === 'DELETE' && req.body && req.body.deletePendingQuoteEmail) {
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/pending_quotes?guest_email=eq.${encodeURIComponent(req.body.deletePendingQuoteEmail)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      if (!resp.ok) return res.status(500).json({ error: 'Errore Supabase: ' + (await resp.text()).slice(0, 200) });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id mancante' });
    try {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/confirmed_bookings?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      });
      if (!resp.ok) return res.status(500).json({ error: 'Errore Supabase: ' + (await resp.text()).slice(0, 200) });
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

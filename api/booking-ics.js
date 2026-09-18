// Genera un file .ics al volo, come vera risposta HTTP con Content-Type
// corretto — a differenza di un Blob generato lato client, questo viene
// SEMPRE riconosciuto da iOS (anche quando l'app gira come PWA installata
// sulla Home) e apre il foglio nativo "Aggiungi a Calendario".
//
// Chiamato via navigazione diretta (window.location.href), non fetch/AJAX:
// deve rispondere con un vero Content-Type: text/calendar.

function fmtDate(d) {
  return (d || '').replace(/-/g, '');
}

export default function handler(req, res) {
  const {
    guestName, checkIn, checkOut, guestEmail, total,
    guests, paymentStatus, notes, code
  } = req.query;

  if (!guestName || !checkIn || !checkOut) {
    res.status(400).send('Dati mancanti per generare l\'evento (nome ospite, check-in e check-out sono obbligatori)');
    return;
  }

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
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Domus 106//ACME//IT',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${fmtDate(checkIn)}`,
    `DTEND;VALUE=DATE:${fmtDate(checkOut)}`,
    `SUMMARY:${paymentBadge} ${guestName} — Domus 106 (${paymentLabel})`,
    `DESCRIPTION:${descParts.join('\\n')}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  const icsContent = lines.join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="prenotazione.ics"');
  res.status(200).send(icsContent);
}

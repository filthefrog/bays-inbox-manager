import { getFreshAccessToken } from '../lib/gmail-token.js';

// Crea un evento a tutto giorno su Google Calendar per il soggiorno confermato.
// Scatta SOLO quando l'utente tocca "Conferma prenotazione" — mai in automatico.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const refreshToken = req.cookies.gmail_refresh;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let token;
  try {
    token = await getFreshAccessToken(refreshToken);
  } catch (err) {
    return res.status(401).json({
      error: err.code === "REFRESH_EXPIRED" ? "Sessione scaduta, riconnetti Gmail" : "Errore nel rinnovo del token Gmail"
    });
  }

  const { guestName, checkIn, checkOut, guestEmail, total } = req.body;
  if (!guestName || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'Nome ospite, check-in e check-out sono obbligatori' });
  }

  const descriptionParts = [];
  if (guestEmail) descriptionParts.push(`Email ospite: ${guestEmail}`);
  if (total) descriptionParts.push(`Totale soggiorno: € ${Number(total).toFixed(2)}`);
  descriptionParts.push('Creato da ACME Inbox Manager');

  const event = {
    summary: `Prenotazione: ${guestName} — Domus 106`,
    description: descriptionParts.join('\n'),
    // fine "esclusiva": il giorno di check-out resta libero per il prossimo ospite
    start: { date: checkIn },
    end: { date: checkOut }
  };

  try {
    const calResp = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    if (!calResp.ok) {
      const detail = await calResp.text();
      throw new Error(`Errore Google Calendar (${calResp.status}): ${detail.slice(0, 200)}`);
    }

    const created = await calResp.json();
    return res.status(200).json({ success: true, eventId: created.id, htmlLink: created.htmlLink });
  } catch (error) {
    console.error('Errore creazione evento calendario:', error);
    return res.status(500).json({ error: error.message });
  }
}

import { Buffer } from 'buffer';
import { getFreshAccessToken } from '../lib/gmail-token.js';
import { calculateQuote } from '../lib/pricing.js';
import { buildQuotePdf } from '../lib/quote-pdf.js';

function wrapBase64(str) {
  return str.match(/.{1,76}/g).join('\r\n');
}

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

  const { to, guestName, checkIn, checkOut } = req.body;

  if (!to || !guestName || !checkIn || !checkOut) {
    return res.status(400).json({ error: 'Dati mancanti: destinatario, nome ospite, check-in e check-out sono obbligatori' });
  }

  let quote;
  try {
    quote = calculateQuote(checkIn, checkOut);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const issuedDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    const checkInFmt = new Date(checkIn + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    const checkOutFmt = new Date(checkOut + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

    const pdfBuffer = await buildQuotePdf({ guestName, checkIn: checkInFmt, checkOut: checkOutFmt, quote, issuedDate });

    const emailText = `Gentile ${guestName},

in allegato trova il preventivo richiesto per il Suo soggiorno presso Domus 106 dal ${checkInFmt} al ${checkOutFmt} (${quote.nights} nott${quote.nights === 1 ? 'e' : 'i'}).

Totale soggiorno: € ${quote.total.toFixed(2)}${quote.discountPercent > 0 ? ` (sconto ${quote.discountPercent}% per soggiorni lunghi già applicato)` : ''}

Resto a disposizione per qualsiasi chiarimento.

Cordiali saluti,
Domus 106`;

    const subject = `Preventivo soggiorno Domus 106 — ${checkInFmt}`;
    const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';

    const boundary = 'acme_boundary_' + Date.now();
    const pdfFilename = `Preventivo_Domus106_${guestName.replace(/[^a-zA-Z0-9]+/g, '_')}.pdf`;

    const message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(emailText, 'utf-8').toString('base64'),
      '',
      `--${boundary}`,
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${pdfFilename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(pdfBuffer.toString('base64')),
      '',
      `--${boundary}--`
    ].join('\r\n');

    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const sendResponse = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ raw: encodedMessage })
      }
    );

    if (!sendResponse.ok) {
      const detail = await sendResponse.text();
      throw new Error(`Gmail send error (${sendResponse.status}): ${detail.slice(0, 200)}`);
    }

    const result = await sendResponse.json();

    let confirmed = false;
    try {
      const checkResp = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${result.id}?format=minimal`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        confirmed = (checkData.labelIds || []).includes('SENT');
      }
    } catch (e) {
      // se la verifica fallisce non blocchiamo comunque la risposta positiva
    }

    return res.status(200).json({
      success: true,
      messageId: result.id,
      confirmed,
      total: quote.total,
      nights: quote.nights
    });

  } catch (error) {
    console.error('Errore generazione preventivo:', error);
    return res.status(500).json({ error: error.message });
  }
}

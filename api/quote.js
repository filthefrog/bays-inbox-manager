import { Buffer } from 'buffer';
import { getFreshAccessToken } from '../lib/gmail-token.js';
import { buildQuoteTotals } from '../lib/pricing.js';
import { buildQuotePdf } from '../lib/quote-pdf.js';

// Un solo endpoint per tutto ciò che riguarda i preventivi (genera+invia,
// genera solo PDF, genera solo il messaggio con l'IA) — accorpato per stare
// sotto il limite di 12 funzioni del piano gratuito Vercel. L'azione richiesta
// va indicata nel campo "action" del corpo della richiesta.

function wrapBase64(str) {
  return str.match(/.{1,76}/g).join('\r\n');
}

async function buildPdfPackage({ guestName, checkIn, checkOut, ratePerNight, discountPercent }) {
  const quote = buildQuoteTotals({ checkIn, checkOut, ratePerNight, discountPercent });
  const issuedDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const checkInFmt = new Date(checkIn + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const checkOutFmt = new Date(checkOut + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const pdfBuffer = await buildQuotePdf({ guestName, checkIn: checkInFmt, checkOut: checkOutFmt, quote, issuedDate });
  const filename = `Preventivo_Domus106_${guestName.replace(/[^a-zA-Z0-9]+/g, '_')}.pdf`;
  return { pdfBuffer, filename, quote, checkInFmt, checkOutFmt };
}

const KNOWLEDGE_BASE = `
- Nome struttura: Domus 106
- Indirizzo: Via Papa Giovanni XXIII, 106, Civitanova Marche (MC)
- Tipo: Affittacamere (NON B&B — colazione non inclusa)
- 2 camere matrimoniali, 4 posti letto totali, 2 bagni completi, 75 mq, piano 1° con ascensore
- Parcheggio: garage privato coperto e interrato incluso
- WiFi: fibra ottica
- Check-in: qualsiasi ora (self check-in con codice digitale)
- Check-out: entro le 11:00
- Tariffe: bassa stagione 80€/notte, alta stagione (giugno-settembre) 150€/notte; sconto 15% per soggiorni di 7+ notti, 30% per 30+ notti
- Spiaggia a circa 1,6 km
- Cancellazione: entro 14 giorni dall'arrivo rimborso totale; 7-14 giorni rimborso 50%; entro 7 giorni nessun rimborso
`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body;

  // --- genera solo il messaggio email con Claude, basato sulla mail del cliente ---
  if (action === 'message') {
    const apiKey = req.headers['x-claude-key'];
    if (!apiKey) return res.status(400).json({ error: 'Claude API key required' });

    const { originalSubject, originalBody, guestName, checkInFmt, checkOutFmt, nights, ratePerNight, discountPercent, total, season } = req.body;
    if (!guestName || !checkInFmt || !checkOutFmt || !nights || !ratePerNight || !total) {
      return res.status(400).json({ error: 'Dati del preventivo mancanti' });
    }

    const prompt = `Sei l'assistente di gestione per Domus 106, un affittacamere a Civitanova Marche. Il gestore ha già preparato un preventivo di soggiorno per un cliente e lo allegherà in PDF a questa email. Il tuo compito è scrivere SOLO il testo dell'email di accompagnamento.

DATI REALI DELLA STRUTTURA (usali se il cliente ha fatto domande su servizi/orari):
${KNOWLEDGE_BASE}

EMAIL RICEVUTA DAL CLIENTE:
Oggetto: ${originalSubject || '(nessun oggetto)'}
Testo: ${originalBody || '(nessun testo)'}

PREVENTIVO GIÀ CALCOLATO (non ricalcolare nulla, usa questi numeri così come sono):
- Ospite: ${guestName}
- Check-in: ${checkInFmt}
- Check-out: ${checkOutFmt}
- Notti: ${nights}
- Stagione: ${season || ''}
- Tariffa a notte: € ${ratePerNight}
${discountPercent > 0 ? `- Sconto applicato: ${discountPercent}%\n` : ''}- Totale soggiorno: € ${total}

ISTRUZIONI:
- Scrivi un'email di risposta che affronti DAVVERO quello che il cliente ha scritto: se ha fatto domande specifiche (su parcheggio, orari, servizi, ecc.) rispondi anche a quelle usando i dati reali sopra, non solo il preventivo
- Menziona che il preventivo dettagliato è allegato in PDF
- Includi nel testo le date del soggiorno e il totale
- Scrivi come scriverebbe davvero una persona alla scrivania, non come un modulo automatico: evita frasi fatte da form standard, evita la struttura troppo perfetta e simmetrica tipica di un testo generato da IA, evita elenchi puntati. Varia la lunghezza delle frasi, tono colloquiale ma curato
- Firma come "Domus 106"
- Rispondi SOLO con il testo dell'email, niente introduzioni, niente markdown, niente virgolette attorno al testo`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 700, messages: [{ role: "user", content: prompt }] })
      });
      if (!response.ok) {
        const errBody = await response.text();
        throw new Error("Claude API error: " + errBody.slice(0, 200));
      }
      const data = await response.json();
      return res.status(200).json({ message: data.content[0].text.trim() });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // --- genera solo il PDF, nessun invio, nessuna autenticazione Gmail necessaria ---
  if (action === 'pdf') {
    const { guestName, checkIn, checkOut, ratePerNight, discountPercent } = req.body;
    if (!guestName || !checkIn || !checkOut || !ratePerNight) {
      return res.status(400).json({ error: 'Dati mancanti: nome ospite, date e tariffa sono obbligatori' });
    }
    try {
      const { pdfBuffer, filename, quote } = await buildPdfPackage({ guestName, checkIn, checkOut, ratePerNight, discountPercent });
      return res.status(200).json({ pdfBase64: pdfBuffer.toString('base64'), filename, total: quote.total, nights: quote.nights });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  // --- default: genera il PDF e lo invia via Gmail (comportamento di prima) ---
  const refreshToken = req.cookies.gmail_refresh;
  if (!refreshToken) return res.status(401).json({ error: 'Not authenticated' });

  let token;
  try {
    token = await getFreshAccessToken(refreshToken);
  } catch (err) {
    return res.status(401).json({
      error: err.code === "REFRESH_EXPIRED" ? "Sessione scaduta, riconnetti Gmail" : "Errore nel rinnovo del token Gmail"
    });
  }

  const { to, guestName, checkIn, checkOut, ratePerNight, discountPercent, emailMessage } = req.body;
  if (!to || !guestName || !checkIn || !checkOut || !ratePerNight) {
    return res.status(400).json({ error: 'Dati mancanti: destinatario, nome ospite, date e tariffa sono obbligatori' });
  }

  try {
    const { pdfBuffer, filename, quote, checkInFmt, checkOutFmt } = await buildPdfPackage({ guestName, checkIn, checkOut, ratePerNight, discountPercent });

    const emailText = (emailMessage && emailMessage.trim()) ? emailMessage : `Gentile ${guestName},

in allegato trova il preventivo richiesto per il Suo soggiorno presso Domus 106 dal ${checkInFmt} al ${checkOutFmt} (${quote.nights} nott${quote.nights === 1 ? 'e' : 'i'}).

Totale soggiorno: € ${quote.total.toFixed(2)}${quote.discountPercent > 0 ? ` (sconto ${quote.discountPercent}% per soggiorni lunghi già applicato)` : ''}

Resto a disposizione per qualsiasi chiarimento.

Cordiali saluti,
Domus 106`;

    const subject = `Preventivo soggiorno Domus 106 — ${checkInFmt}`;
    const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
    const boundary = 'acme_boundary_' + Date.now();

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
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(pdfBuffer.toString('base64')),
      '',
      `--${boundary}--`
    ].join('\r\n');

    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const sendResponse = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodedMessage })
    });

    if (!sendResponse.ok) {
      const detail = await sendResponse.text();
      throw new Error(`Gmail send error (${sendResponse.status}): ${detail.slice(0, 200)}`);
    }

    const result = await sendResponse.json();

    let confirmed = false;
    try {
      const checkResp = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${result.id}?format=minimal`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        confirmed = (checkData.labelIds || []).includes('SENT');
      }
    } catch (e) {}

    return res.status(200).json({ success: true, messageId: result.id, confirmed, total: quote.total, nights: quote.nights });
  } catch (error) {
    console.error('Errore generazione preventivo:', error);
    return res.status(500).json({ error: error.message });
  }
}

import { Buffer } from 'buffer';
import { getFreshAccessToken } from '../lib/gmail-token.js';
import { computeQuote } from '../lib/pricing.js';
import { KNOWLEDGE_BASE } from '../lib/analyze-email.js';
import { buildQuotePdf } from '../lib/quote-pdf.js';

// Un solo endpoint per tutto ciò che riguarda i preventivi (genera+invia,
// genera solo PDF, genera solo il messaggio con l'IA) — accorpato per stare
// sotto il limite di 12 funzioni del piano gratuito Vercel. L'azione richiesta
// va indicata nel campo "action" del corpo della richiesta.

function wrapBase64(str) {
  return str.match(/.{1,76}/g).join('\r\n');
}

const eur = (n) => '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2, useGrouping: 'always' });

// Dati del preventivo dal corpo della richiesta. "ratePerNight" resta accettato
// come tariffa forzata per compatibilità con le versioni precedenti dell'app.
function quoteInput(body) {
  const b = body || {};
  return {
    guestName: (b.guestName || '').trim(),
    checkIn: b.checkIn, checkOut: b.checkOut,
    guests: b.guests, rooms: b.rooms,
    rateOverride: b.rateOverride !== undefined ? b.rateOverride : b.ratePerNight,
    discountPercent: b.discountPercent,
    withSecurityDeposit: !!b.withSecurityDeposit
  };
}

// Riepilogo in parole, uguale per l'email automatica e per il prompt dell'IA
function quoteLines(q) {
  const L = q.groups.map(g => `${g.nights} nott${g.nights === 1 ? 'e' : 'i'} in ${g.season.toLowerCase()} a ${eur(g.rate)}`);
  if (q.rooms === 2) L.push(`seconda camera: ${eur(q.secondRoomNightly)} per le notti più ${eur(q.secondRoomOneOff)} di biancheria e pulizia`);
  if (q.discountPercent > 0) L.push(`sconto soggiorni lunghi ${q.discountPercent}%: − ${eur(q.discountAmount)}`);
  return L;
}

async function buildPdfPackage(input) {
  const { guestName, checkIn, checkOut } = input;
  const quote = computeQuote(input);
  const issuedDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const checkInFmt = new Date(checkIn + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const checkOutFmt = new Date(checkOut + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const pdfBuffer = await buildQuotePdf({ guestName, checkIn: checkInFmt, checkOut: checkOutFmt, quote, issuedDate });
  const filename = `Preventivo_Domus106_${guestName.replace(/[^a-zA-Z0-9]+/g, '_')}.pdf`;
  return { pdfBuffer, filename, quote, checkInFmt, checkOutFmt };
}


export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body;

  // --- genera solo il messaggio email con Claude, basato sulla mail del cliente ---
  if (action === 'message') {
    const apiKey = req.headers['x-claude-key'];
    if (!apiKey) return res.status(400).json({ error: 'Claude API key required' });

    const { originalSubject, originalBody } = req.body;
    const input = quoteInput(req.body);
    if (!input.guestName || !input.checkIn || !input.checkOut) {
      return res.status(400).json({ error: 'Dati del preventivo mancanti' });
    }
    let q;
    try { q = computeQuote(input); } catch (err) { return res.status(400).json({ error: err.message }); }
    const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    const guestName = input.guestName, checkInFmt = fmt(input.checkIn), checkOutFmt = fmt(input.checkOut);

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
- Notti: ${q.nights} · Ospiti: ${q.guests} · Camere: ${q.rooms === 2 ? 'entrambe' : 'solo la padronale (la seconda resta chiusa)'}
${quoteLines(q).map(l => '- ' + l).join('\n')}
- Totale soggiorno: ${eur(q.total)}
- Acconto per confermare (${q.depositPercent}%): ${eur(q.depositAmount)}${q.securityDeposit ? `\n- Cauzione: ${eur(q.securityDeposit)} con bonifico prima dell'arrivo, restituita dopo il check-out` : ''}

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
    const input = quoteInput(req.body);
    if (!input.guestName || !input.checkIn || !input.checkOut) {
      return res.status(400).json({ error: 'Dati mancanti: nome ospite e date sono obbligatori' });
    }
    try {
      const { pdfBuffer, filename, quote } = await buildPdfPackage(input);
      return res.status(200).json({ pdfBase64: pdfBuffer.toString('base64'), filename, total: quote.total, nights: quote.nights, quote });
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

  const { to, emailMessage, threadId, inReplyTo, replySubject } = req.body;
  const input = quoteInput(req.body);
  const guestName = input.guestName;
  if (!to || !guestName || !input.checkIn || !input.checkOut) {
    return res.status(400).json({ error: 'Dati mancanti: destinatario, nome ospite e date sono obbligatori' });
  }

  try {
    const { pdfBuffer, filename, quote, checkInFmt, checkOutFmt } = await buildPdfPackage(input);

    const emailText = (emailMessage && emailMessage.trim()) ? emailMessage : `Gentile ${guestName},

in allegato trova il preventivo richiesto per il Suo soggiorno presso Domus 106 dal ${checkInFmt} al ${checkOutFmt} (${quote.nights} nott${quote.nights === 1 ? 'e' : 'i'}).

Totale soggiorno: ${eur(quote.total)}${quote.discountPercent > 0 ? ` (sconto ${quote.discountPercent}% per soggiorni lunghi già applicato)` : ''}
Per confermare: acconto di ${eur(quote.depositAmount)} (${quote.depositPercent}%).

Resto a disposizione per qualsiasi chiarimento.

Cordiali saluti,
Domus 106`;

    // Se il preventivo risponde a un'email dell'ospite, resta nella stessa
    // conversazione: stesso oggetto con "Re:", In-Reply-To/References e threadId.
    const replyRef = typeof inReplyTo === 'string' && /^<[^<>\r\n]+>$/.test(inReplyTo.trim()) ? inReplyTo.trim() : null;
    const threaded = !!(replyRef && replySubject);
    const cleanReplySubject = String(replySubject || '').replace(/[\r\n]+/g, ' ');
    const subject = threaded
      ? (/^\s*re\s*:/i.test(cleanReplySubject) ? cleanReplySubject : 'Re: ' + cleanReplySubject)
      : `Preventivo soggiorno Domus 106 — ${checkInFmt}`;
    const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';
    const boundary = 'acme_boundary_' + Date.now();

    const message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      ...(threaded ? [`In-Reply-To: ${replyRef}`, `References: ${replyRef}`] : []),
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
      body: JSON.stringify(threaded && threadId ? { raw: encodedMessage, threadId } : { raw: encodedMessage })
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

    return res.status(200).json({ success: true, messageId: result.id, confirmed, total: quote.total, nights: quote.nights, quote });
  } catch (error) {
    console.error('Errore generazione preventivo:', error);
    return res.status(500).json({ error: error.message });
  }
}

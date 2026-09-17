import { buildQuoteTotals } from '../lib/pricing.js';
import { buildQuotePdf } from '../lib/quote-pdf.js';

// Genera solo il PDF del preventivo e lo restituisce in base64, senza inviare
// nessuna email — usato dalla condivisione diretta (WhatsApp, AirDrop, ecc.).
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { guestName, checkIn, checkOut, ratePerNight, discountPercent } = req.body;

  if (!guestName || !checkIn || !checkOut || !ratePerNight) {
    return res.status(400).json({ error: 'Dati mancanti: nome ospite, date e tariffa sono obbligatori' });
  }

  let quote;
  try {
    quote = buildQuoteTotals({ checkIn, checkOut, ratePerNight, discountPercent });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const issuedDate = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    const checkInFmt = new Date(checkIn + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
    const checkOutFmt = new Date(checkOut + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });

    const pdfBuffer = await buildQuotePdf({ guestName, checkIn: checkInFmt, checkOut: checkOutFmt, quote, issuedDate });
    const filename = `Preventivo_Domus106_${guestName.replace(/[^a-zA-Z0-9]+/g, '_')}.pdf`;

    return res.status(200).json({
      pdfBase64: pdfBuffer.toString('base64'),
      filename,
      total: quote.total,
      nights: quote.nights
    });
  } catch (error) {
    console.error('Errore generazione PDF preventivo:', error);
    return res.status(500).json({ error: error.message });
  }
}

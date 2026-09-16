import PDFDocument from 'pdfkit';
import { instrumentSansRegular, instrumentSansBold } from './fonts.js';

// Genera il PDF del preventivo. Layout sempre identico, cambiano solo i dati.
export function buildQuotePdf({ guestName, checkIn, checkOut, quote, issuedDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Regular', instrumentSansRegular);
    doc.registerFont('Bold', instrumentSansBold);

    const accent = '#0a6ebd';
    const accentSoft = '#eaf3fb';
    const dark = '#1c1c1e';
    const gray = '#8a8a8e';
    const line = '#e8e8ea';

    const pageWidth = doc.page.width;
    const margin = 56;
    const contentWidth = pageWidth - margin * 2;

    // Sottile barra di colore in cima alla pagina — un unico tocco di firma
    doc.rect(0, 0, pageWidth, 6).fill(accent);

    let y = 50;

    // Intestazione: marchio a sinistra, etichetta documento a destra
    doc.fillColor(accent).font('Bold').fontSize(10).text('D O M U S   1 0 6', margin, y);
    doc.fillColor(gray).font('Regular').fontSize(9)
      .text('P R E V E N T I V O', margin, y + 1, { width: contentWidth, align: 'right' });

    y += 36;
    doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor(line).lineWidth(0.75).stroke();
    y += 36;

    // Titolo e data di emissione
    doc.fillColor(dark).font('Bold').fontSize(24).text('Preventivo di soggiorno', margin, y);
    y += 32;
    doc.fillColor(gray).font('Regular').fontSize(9.5)
      .text(`Emesso il ${issuedDate}  ·  valido 7 giorni dalla data di emissione`, margin, y);

    y += 42;

    // Saluto cortese
    doc.fillColor(dark).font('Bold').fontSize(13).text(`Gentile ${guestName},`, margin, y, { width: contentWidth });
    y += 22;
    doc.fillColor(gray).font('Regular').fontSize(10.5).text(
      'con piacere Le confermiamo il dettaglio del Suo soggiorno presso Domus 106, a Civitanova Marche.',
      margin, y, { width: contentWidth, lineGap: 2 }
    );

    y += 50;

    // Dettagli soggiorno — righe pulite, valori allineati a destra con precisione
    const detailRows = [
      ['Check-in', checkIn],
      ['Check-out', checkOut],
      ['Notti', String(quote.nights)],
      ['Stagione', quote.season],
      ['Tariffa a notte', `€ ${quote.ratePerNight.toFixed(2)}`]
    ];

    doc.fontSize(10.5);
    detailRows.forEach(([label, value]) => {
      doc.fillColor(gray).font('Regular').text(label, margin, y);
      doc.fillColor(dark).font('Bold').text(value, margin, y, { width: contentWidth, align: 'right' });
      y += 24;
      doc.moveTo(margin, y - 8).lineTo(pageWidth - margin, y - 8).strokeColor(line).lineWidth(0.5).stroke();
    });

    y += 10;

    doc.fillColor(gray).font('Regular').text('Subtotale', margin, y);
    doc.fillColor(dark).font('Bold').text(`€ ${quote.subtotal.toFixed(2)}`, margin, y, { width: contentWidth, align: 'right' });
    y += 24;

    if (quote.discountPercent > 0) {
      doc.fillColor(gray).font('Regular').text(`Sconto soggiorni lunghi (${quote.discountPercent}%)`, margin, y);
      doc.fillColor(accent).font('Bold').text(`− € ${quote.discountAmount.toFixed(2)}`, margin, y, { width: contentWidth, align: 'right' });
      y += 24;
    }

    y += 16;

    // Riquadro totale — l'unico elemento davvero "in rilievo" della pagina
    const boxHeight = 64;
    doc.roundedRect(margin, y, contentWidth, boxHeight, 12).fill(accentSoft);
    doc.fillColor(dark).font('Bold').fontSize(12).text('Totale soggiorno', margin + 20, y + 24);
    doc.fillColor(accent).font('Bold').fontSize(22).text(`€ ${quote.total.toFixed(2)}`, margin, y + 18, { width: contentWidth - 20, align: 'right' });

    y += boxHeight + 40;

    // Note pratiche, tono cortese e discreto
    doc.fillColor(gray).font('Regular').fontSize(8.5).text(
      'Politica di cancellazione — rimborso totale oltre 14 giorni dall\'arrivo, 50% tra 7 e 14 giorni, nessun rimborso entro 7 giorni dall\'arrivo.',
      margin, y, { width: contentWidth, lineGap: 3 }
    );
    y += 28;
    doc.text(
      'Il soggiorno include parcheggio privato coperto e interrato, connessione WiFi in fibra ottica e check-in autonomo con codice digitale. Check-out entro le ore 11:00.',
      margin, y, { width: contentWidth, lineGap: 3 }
    );

    // Chiusura in fondo pagina, per bilanciare l'intestazione
    const footerY = doc.page.height - 80;
    doc.moveTo(margin, footerY).lineTo(pageWidth - margin, footerY).strokeColor(line).lineWidth(0.75).stroke();
    doc.fillColor(gray).font('Regular').fontSize(9).text('Restiamo a Sua disposizione per qualsiasi chiarimento.', margin, footerY + 14);
    doc.fillColor(accent).font('Bold').fontSize(9)
      .text('D O M U S   1 0 6', margin, footerY + 14, { width: contentWidth, align: 'right' });
    doc.fillColor(gray).font('Regular').fontSize(8)
      .text('Via Papa Giovanni XXIII, 106 — Civitanova Marche (MC)', margin, footerY + 30, { width: contentWidth, align: 'right' });

    doc.end();
  });
}

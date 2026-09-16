import PDFDocument from 'pdfkit';

// Genera il PDF del preventivo. Layout sempre identico, cambiano solo i dati.
export function buildQuotePdf({ guestName, checkIn, checkOut, quote, issuedDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const accent = '#0a6ebd';
    const dark = '#1c1c1e';
    const gray = '#6b6b6f';
    const line = '#e5e5e7';

    // Intestazione
    doc.fillColor(accent).fontSize(20).font('Helvetica-Bold').text('Domus 106', 50, 50);
    doc.fillColor(gray).fontSize(9).font('Helvetica')
      .text('Via Papa Giovanni XXIII, 106 — Civitanova Marche (MC)', 50, 74);

    doc.moveTo(50, 100).lineTo(545, 100).strokeColor(line).lineWidth(1).stroke();

    // Titolo documento
    doc.fillColor(dark).fontSize(16).font('Helvetica-Bold').text('Preventivo di soggiorno', 50, 118);
    doc.fillColor(gray).fontSize(9).font('Helvetica').text(`Data: ${issuedDate}`, 50, 140);

    // Destinatario
    doc.fillColor(dark).fontSize(11).font('Helvetica-Bold').text('Gentile ' + guestName, 50, 170, { width: 495 });

    // Tabella soggiorno
    let y = 205;
    const rows = [
      ['Check-in', checkIn],
      ['Check-out', checkOut],
      ['Notti', String(quote.nights)],
      ['Stagione', quote.season],
      ['Tariffa a notte', `€ ${quote.ratePerNight.toFixed(2)}`]
    ];
    doc.fontSize(10);
    rows.forEach(([label, value]) => {
      doc.fillColor(gray).font('Helvetica').text(label, 50, y);
      doc.fillColor(dark).font('Helvetica-Bold').text(value, 300, y);
      y += 22;
    });

    y += 8;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(line).stroke();
    y += 16;

    doc.fillColor(gray).font('Helvetica').text('Subtotale', 50, y);
    doc.fillColor(dark).font('Helvetica-Bold').text(`€ ${quote.subtotal.toFixed(2)}`, 300, y);
    y += 22;

    if (quote.discountPercent > 0) {
      doc.fillColor(gray).font('Helvetica').text(`Sconto soggiorni lunghi (${quote.discountPercent}%)`, 50, y);
      doc.fillColor(accent).font('Helvetica-Bold').text(`− € ${quote.discountAmount.toFixed(2)}`, 300, y);
      y += 22;
    }

    y += 4;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(dark).lineWidth(1).stroke();
    y += 14;

    doc.fillColor(dark).fontSize(13).font('Helvetica-Bold').text('Totale', 50, y);
    doc.fillColor(accent).fontSize(13).font('Helvetica-Bold').text(`€ ${quote.total.toFixed(2)}`, 300, y);

    // Note
    y += 46;
    doc.fillColor(gray).fontSize(8).font('Helvetica').text(
      'Politica di cancellazione: rimborso totale oltre 14 giorni dall\'arrivo, 50% tra 7 e 14 giorni, nessun rimborso entro 7 giorni dall\'arrivo.',
      50, y, { width: 495 }
    );
    y += 26;
    doc.text(
      'Preventivo valido 7 giorni dalla data di emissione. Parcheggio privato coperto e interrato incluso, WiFi in fibra ottica, check-in autonomo con codice digitale, check-out entro le 11:00.',
      50, y, { width: 495 }
    );

    doc.end();
  });
}

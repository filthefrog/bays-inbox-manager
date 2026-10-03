import PDFDocument from 'pdfkit';
import { serifRegular, serifMedium, serifItalic, sansRegular, sansSemiBold } from './fonts.js';

// Palette e tipografia identiche al sito (Domus 106): fondo carta, salvia per
// gli accenti, marrone per l'unico elemento "pieno", Newsreader + Public Sans.
// I colori con trasparenza del sito sono già fusi sul fondo su cui compaiono.
const C = {
  sfondo: '#F8F9F6',
  superficie: '#FFFFFF',
  testo: '#2B2F29',
  titoli: '#24281F',
  muted: '#64695F',
  salvia: '#6E7F63',
  marrone: '#6B4E3D',
  bordo: '#DFE1DD',        // rgba(43,47,41,.12) sul fondo
  bordoChiaro: '#E6E6E5',  // rgba(43,47,41,.12) sul bianco
  bolla: '#E6E9E3',        // rgba(110,127,99,.13) sul fondo
  scuro: '#2C332A',        // sipario dell'intro
  scuroSalvia: '#A8B89C'
};

// Icone del sito (viewBox 24×24, solo contorno)
const ICONE = {
  garage: ['M4 21V10l8 -6 8 6v11', 'M9 21v-7h6v7'],
  wifi: ['M3 8a15 15 0 0 1 18 0', 'M6.5 12a9 9 0 0 1 11 0', 'M10 16a4 4 0 0 1 4 0', 'M11 19a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'],
  porta: ['M6 21V4a1 1 0 0 1 1 -1h10a1 1 0 0 1 1 1v17', 'M3 21h18', 'M14 11.5v1.5'],
  clima: ['M4 6h16a1 1 0 0 1 1 1v7a1 1 0 0 1 -1 1H4a1 1 0 0 1 -1 -1V7a1 1 0 0 1 1 -1z', 'M7 19l1.5 -4M17 19l-1.5 -4M11 15v4M13 15v4']
};

const euro = (n) => '€ ' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });

// Genera il PDF del preventivo. Layout sempre identico, cambiano solo i dati.
export function buildQuotePdf({ guestName, checkIn, checkOut, quote, issuedDate }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      info: { Title: `Preventivo Domus 106 — ${guestName}`, Author: 'Domus 106' }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('Serif', serifRegular);
    doc.registerFont('SerifMedium', serifMedium);
    doc.registerFont('SerifItalic', serifItalic);
    doc.registerFont('Sans', sansRegular);
    doc.registerFont('SansSemi', sansSemiBold);

    const W = doc.page.width;
    const H = doc.page.height;
    const margin = 56;
    const cw = W - margin * 2;

    // Etichetta maiuscola spaziata, come le "eyebrow" del sito
    const eyebrow = (text, x, y, opts = {}) => {
      doc.fillColor(opts.color || C.salvia).font('SansSemi').fontSize(opts.size || 7.5)
        .text(text.toUpperCase(), x, y, { characterSpacing: opts.spacing ?? 0.85, lineBreak: false, ...opts.text });
    };
    const label = (text, x, y, opts = {}) => eyebrow(text, x, y, { color: C.muted, size: 6.8, spacing: 0.45, ...opts });
    const hline = (x1, x2, y, color = C.bordo, w = 0.75) => {
      doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(w).stroke();
    };
    const icona = (nome, x, y, size) => {
      doc.save().translate(x, y).scale(size / 24);
      ICONE[nome].forEach((d) => doc.path(d));
      doc.lineWidth(1.4).lineCap('round').lineJoin('round').strokeColor(C.salvia).stroke();
      doc.restore();
    };

    // Fondo carta, come la pagina del sito
    doc.rect(0, 0, W, H).fill(C.sfondo);

    // Testata scura: lo stesso "sipario" con cui si apre il sito
    const bandH = 92;
    doc.rect(0, 0, W, bandH).fill(C.scuro);
    doc.font('Serif').fontSize(26);
    const domusW = doc.widthOfString('Domus ');
    doc.fillColor(C.sfondo).text('Domus ', margin, 30, { lineBreak: false });
    doc.fillColor(C.scuroSalvia).font('SerifItalic').text('106', margin + domusW, 30, { lineBreak: false });
    eyebrow('Civitanova Marche', margin, 38, { color: C.scuroSalvia, text: { width: cw, align: 'right' } });
    doc.fillColor('#B9C4AE').font('Sans').fontSize(8)
      .text('zona Villa Pini', margin, 51, { width: cw, align: 'right', lineBreak: false });

    let y = bandH + 46;

    // Titolo, centrato come l'apertura del sito
    eyebrow('Preventivo di soggiorno', margin, y, { text: { width: cw, align: 'center' } });
    y += 20;
    doc.fillColor(C.titoli).font('SerifMedium').fontSize(30)
      .text(`Per ${guestName}`, margin, y, { width: cw, align: 'center' });
    y = doc.y + 8;
    doc.fillColor(C.muted).font('Sans').fontSize(9.5)
      .text(`Emesso il ${issuedDate}  ·  valido salvo disponibilità`, margin, y, { width: cw, align: 'center' });
    y = doc.y + 30;

    // Striscia dei numeri, come i "facts" sotto l'apertura del sito
    const facts = [
      [String(quote.nights), quote.nights === 1 ? 'notte' : 'notti'],
      [euro(quote.ratePerNight), 'tariffa a notte'],
      [quote.season.replace(' stagione', ''), 'stagione'],
      [quote.discountPercent > 0 ? `${quote.discountPercent}%` : '—', 'sconto soggiorni lunghi']
    ];
    const factsH = 64;
    doc.rect(0, y, W, factsH).fill(C.superficie);
    hline(0, W, y);
    hline(0, W, y + factsH);
    const cellW = cw / facts.length;
    facts.forEach(([n, l], i) => {
      const x = margin + i * cellW;
      if (i > 0) doc.moveTo(x, y + 14).lineTo(x, y + factsH - 14).strokeColor(C.bordoChiaro).lineWidth(0.75).stroke();
      doc.fillColor(C.salvia).font('SerifItalic').fontSize(19)
        .text(n, x, y + 13, { width: cellW, align: 'center', lineBreak: false });
      label(l, x, y + 40, { text: { width: cellW, align: 'center' } });
    });
    y += factsH + 30;

    // Arrivo / partenza, gli stessi riquadri del calendario del sito
    const gap = 12;
    const boxW = (cw - gap) / 2;
    const boxH = 50;
    [['Arrivo', checkIn], ['Partenza', checkOut]].forEach(([t, v], i) => {
      const x = margin + i * (boxW + gap);
      doc.roundedRect(x, y, boxW, boxH, 5).fillAndStroke(C.superficie, C.bordo);
      label(t, x + 14, y + 11);
      doc.fillColor(C.titoli).font('Serif').fontSize(15).text(v, x + 14, y + 23, { width: boxW - 28, lineBreak: false });
    });
    y += boxH + 26;

    // Conto
    eyebrow('Dettaglio', margin, y);
    y += 18;
    const righe = [
      [`${quote.nights} ${quote.nights === 1 ? 'notte' : 'notti'} × ${euro(quote.ratePerNight)}`, euro(quote.subtotal), C.titoli]
    ];
    if (quote.discountPercent > 0) {
      righe.push([`Sconto soggiorni lunghi (${quote.discountPercent}%)`, `− ${euro(quote.discountAmount)}`, C.salvia]);
    }
    righe.forEach(([l, v, col]) => {
      hline(margin, W - margin, y);
      y += 11;
      doc.fillColor(C.testo).font('Sans').fontSize(10.5).text(l, margin, y, { lineBreak: false });
      doc.fillColor(col).font('SansSemi').text(v, margin, y, { width: cw, align: 'right', lineBreak: false });
      y += 24;
    });
    y += 6;

    // Totale: l'unico elemento pieno, come il pulsante marrone del sito
    const totH = 62;
    doc.roundedRect(margin, y, cw, totH, 2).fill(C.marrone);
    eyebrow('Totale soggiorno', margin + 22, y + 26, { color: '#FFFFFF', size: 8, spacing: 0.6 });
    doc.fillColor('#FFFFFF').font('SerifMedium').fontSize(24)
      .text(euro(quote.total), margin, y + 17, { width: cw - 22, align: 'right', lineBreak: false });
    y += totH + 32;

    // Cosa include, la stessa griglia "Servizi" del sito
    eyebrow('Incluso nel soggiorno', margin, y);
    y += 18;
    const servizi = [
      ['garage', 'Garage privato coperto'],
      ['wifi', 'Wifi in fibra'],
      ['porta', 'Self check-in'],
      ['clima', 'Clima in ogni stanza']
    ];
    const sW = cw / servizi.length;
    const sH = 66;
    doc.roundedRect(margin, y, cw, sH, 6).fillAndStroke(C.superficie, C.bordo);
    servizi.forEach(([ic, t], i) => {
      const x = margin + i * sW;
      if (i > 0) doc.moveTo(x, y).lineTo(x, y + sH).strokeColor(C.bordo).lineWidth(0.75).stroke();
      icona(ic, x + 14, y + 13, 16);
      doc.fillColor(C.testo).font('SansSemi').fontSize(8.5).text(t, x + 14, y + 38, { width: sW - 24, lineBreak: false });
    });
    y += sH + 26;

    // Note pratiche
    doc.fillColor(C.muted).font('Sans').fontSize(8.5).text(
      'Cancellazione: rimborso totale oltre 14 giorni dall\'arrivo, 50% tra 7 e 14 giorni, nessun rimborso entro 7 giorni. ' +
      'Check-in a qualsiasi ora, check-out entro le 11:00.',
      margin, y, { width: cw, lineGap: 3 }
    );

    // Piede centrato, come il footer del sito
    const footerY = H - 78;
    hline(0, W, footerY);
    doc.fillColor(C.titoli).font('SerifItalic').fontSize(12)
      .text('Domus 106', margin, footerY + 18, { width: cw, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Sans').fontSize(8.5)
      .text('Via Papa Giovanni XXIII, 106 — Civitanova Marche (MC)', margin, footerY + 37, { width: cw, align: 'center', lineBreak: false });

    doc.end();
  });
}

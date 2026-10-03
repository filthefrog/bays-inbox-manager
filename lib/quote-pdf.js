import PDFDocument from 'pdfkit';
import { serifRegular, serifMedium, serifItalic, sansRegular, sansSemiBold } from './fonts.js';

// Palette e tipografia identiche al sito (Domus 106): fondo carta, salvia per
// gli accenti, marrone per il totale, Newsreader + Public Sans.
// I colori con trasparenza del sito sono già fusi sul fondo su cui compaiono.
const C = {
  sfondo: '#F8F9F6',
  testo: '#2B2F29',
  titoli: '#24281F',
  muted: '#64695F',
  salvia: '#6E7F63',
  marrone: '#6B4E3D',
  bordo: '#DFE1DD' // rgba(43,47,41,.12) sul fondo
};

// Importi senza ",00" quando sono interi: una cifra più corta si percepisce più piccola
const cifra = (n) => {
  const d = Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2;
  return n.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' });
};
const euro = (n) => '€ ' + cifra(n);

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
    const margin = 64;
    const cw = W - margin * 2;

    // Etichetta maiuscola spaziata, come le "eyebrow" del sito
    const eyebrow = (text, x, y, opts = {}) => {
      doc.fillColor(opts.color || C.muted).font('SansSemi').fontSize(7)
        .text(text.toUpperCase(), x, y, { characterSpacing: 0.8, lineBreak: false, ...opts.text });
    };
    const hline = (y, color = C.bordo, w = 0.75) => {
      doc.moveTo(margin, y).lineTo(W - margin, y).strokeColor(color).lineWidth(w).stroke();
    };

    // Fondo carta, come la pagina del sito
    doc.rect(0, 0, W, H).fill(C.sfondo);

    // Intestazione: il marchio del sito, la data a destra
    let y = 58;
    doc.font('Serif').fontSize(20);
    const domusW = doc.widthOfString('Domus ');
    doc.fillColor(C.titoli).text('Domus ', margin, y, { lineBreak: false });
    doc.fillColor(C.salvia).font('SerifItalic').text('106', margin + domusW, y, { lineBreak: false });
    doc.fillColor(C.muted).font('Sans').fontSize(8.5)
      .text(issuedDate, margin, y + 8, { width: cw, align: 'right', lineBreak: false });
    y += 44;
    hline(y);

    // Titolo
    y += 64;
    eyebrow('Preventivo di soggiorno', margin, y, { color: C.salvia });
    y += 18;
    doc.fillColor(C.titoli).font('SerifMedium').fontSize(32).text(guestName, margin, y, { width: cw });
    y = doc.y + 52;

    // Soggiorno: tre colonne di solo testo
    const cols = [
      ['Arrivo', checkIn],
      ['Partenza', checkOut],
      ['Notti', String(quote.nights)]
    ];
    const colW = [cw * 0.4, cw * 0.4, cw * 0.2];
    let x = margin;
    cols.forEach(([l, v], i) => {
      eyebrow(l, x, y);
      doc.fillColor(C.titoli).font('Serif').fontSize(16).text(v, x, y + 16, { width: colW[i], lineBreak: false });
      x += colW[i];
    });
    y += 68;

    // Conto. Psicologia del prezzo: lo sconto è la cifra più evidente, il totale
    // resta sobrio (simbolo € piccolo, prezzo pieno barrato, costo a notte sotto).
    hline(y);
    y += 14;
    doc.fillColor(C.testo).font('Sans').fontSize(10.5)
      .text(`${quote.nights} ${quote.nights === 1 ? 'notte' : 'notti'} × ${euro(quote.ratePerNight)}`, margin, y, { lineBreak: false });
    doc.text(euro(quote.subtotal), margin, y, { width: cw, align: 'right', lineBreak: false });
    y += 28;

    const sconto = quote.discountPercent > 0;
    if (sconto) {
      hline(y);
      y += 14;
      doc.fillColor(C.salvia).font('SansSemi').fontSize(10.5)
        .text(`Sconto soggiorni lunghi ${quote.discountPercent}%`, margin, y + 5, { lineBreak: false });
      doc.font('SerifItalic').fontSize(22)
        .text(`− ${euro(quote.discountAmount)}`, margin, y - 3, { width: cw, align: 'right', lineBreak: false });
      y += 40;
    }

    hline(y, C.titoli, 1);
    y += 18;
    eyebrow('Totale soggiorno', margin, y + 6, { color: C.titoli });
    // Importo composto da destra: [prezzo pieno barrato]  € totale
    const num = cifra(quote.total);
    doc.font('SerifMedium').fontSize(17);
    const numW = doc.widthOfString(num);
    let xr = W - margin - numW;
    doc.fillColor(C.titoli).text(num, xr, y, { lineBreak: false });
    doc.font('Sans').fontSize(9);
    const simW = doc.widthOfString('€ ');
    xr -= simW;
    doc.fillColor(C.muted).text('€ ', xr, y + 6, { lineBreak: false });
    if (sconto) {
      const pieno = euro(quote.subtotal);
      const pienoW = doc.widthOfString(pieno);
      xr -= pienoW + 14;
      doc.fillColor(C.muted).text(pieno, xr, y + 6, { lineBreak: false });
      doc.moveTo(xr - 1, y + 10).lineTo(xr + pienoW + 1, y + 10).strokeColor(C.muted).lineWidth(0.6).stroke();
    }
    // Il costo a notte scontato ridimensiona il totale (senza sconto sarebbe una ripetizione)
    if (sconto) doc.fillColor(C.muted).font('Sans').fontSize(8.5)
      .text(`pari a ${euro(quote.total / quote.nights)} a notte`, margin, y + 26, { width: cw, align: 'right', lineBreak: false });
    y += 84;

    // Condizioni, in una colonna sobria
    const nota = (titolo, testo) => {
      eyebrow(titolo, margin, y);
      doc.fillColor(C.muted).font('Sans').fontSize(9)
        .text(testo, margin, y + 14, { width: cw * 0.78, lineGap: 2.5 });
      y = doc.y + 18;
    };
    nota('Incluso', 'Garage privato coperto, wifi in fibra, self check-in con codice a qualsiasi ora. Check-out entro le 11:00.');
    nota('Cancellazione', 'Rimborso totale oltre 14 giorni dall\'arrivo, 50% tra 7 e 14 giorni, nessun rimborso entro 7 giorni. Preventivo valido salvo disponibilità.');

    // Piede centrato, come il footer del sito
    const footerY = H - 74;
    hline(footerY);
    doc.fillColor(C.titoli).font('SerifItalic').fontSize(11)
      .text('Domus 106', margin, footerY + 18, { width: cw, align: 'center', lineBreak: false });
    doc.fillColor(C.muted).font('Sans').fontSize(8)
      .text('Via Papa Giovanni XXIII, 106 — Civitanova Marche (MC)', margin, footerY + 35, { width: cw, align: 'center', lineBreak: false });

    doc.end();
  });
}

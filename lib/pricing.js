// LISTINO UNICO di Domus 106 — usato dal server (PDF, email, IA) e dall'app
// nel browser (/lib/pricing.js). Per cambiare un prezzo si tocca solo qui:
// preventivi, PDF, anteprime e risposte dell'IA si aggiornano tutti insieme.
// Nessun import: il file deve funzionare così com'è anche nel browser.

export const PRICING = {
  // Tariffa a notte dell'appartamento con la camera padronale (fino a 2 ospiti).
  // La stagione si decide NOTTE PER NOTTE: un soggiorno 28 maggio → 5 giugno
  // paga le notti di maggio in bassa e quelle di giugno in alta.
  seasons: [
    // minNights: soggiorno minimo se l'arrivo cade in questa stagione (1 = nessun minimo)
    { name: 'Alta stagione', months: [6, 7, 8, 9], rate: 150, secondRoomPerNight: 30, minNights: 1 },
    { name: 'Bassa stagione', months: [1, 2, 3, 4, 5, 10, 11, 12], rate: 80, secondRoomPerNight: 20, minNights: 1 }
  ],
  // Seconda camera: biancheria, asciugamani e pulizia di camera e secondo bagno,
  // una volta per soggiorno (le lenzuola si cambiano a soggiorno, non a notte).
  secondRoomOneOff: 25,
  // Da quanti ospiti la seconda camera è obbligatoria
  secondRoomFromGuests: 3,
  maxGuests: 4,
  // Sconto soggiorni lunghi: si applica solo alla parte a notte
  longStay: [
    { minNights: 30, percent: 30 },
    { minNights: 7, percent: 15 }
  ],
  // Acconto per confermare (percentuale sul totale)
  depositPercent: 30,
  // Cauzione per le prenotazioni dirette, con bonifico prima dell'arrivo
  securityDeposit: 150,
  securityDepositRefundDays: 7,
  checkoutTime: '11:00'
};

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (iso) => new Date(iso + 'T00:00:00Z');
const round2 = (n) => Math.round(n * 100) / 100;

export function seasonOf(isoDate) {
  const month = utc(isoDate).getUTCMonth() + 1;
  return PRICING.seasons.find(s => s.months.includes(month)) || PRICING.seasons[PRICING.seasons.length - 1];
}

export function countNights(checkIn, checkOut) {
  const a = utc(checkIn), b = utc(checkOut);
  if (isNaN(a) || isNaN(b)) throw new Error('Date non valide');
  const nights = Math.round((b - a) / 86400000);
  if (!(nights > 0)) throw new Error('Il check-out deve essere successivo al check-in');
  return nights;
}

// Le date di ogni notte del soggiorno (la notte del check-out non si conta)
export function nightDates(checkIn, checkOut) {
  const n = countNights(checkIn, checkOut);
  const start = utc(checkIn);
  return Array.from({ length: n }, (_, i) => isoOf(new Date(start.getTime() + i * 86400000)));
}

export function suggestedDiscount(nights) {
  const tier = PRICING.longStay.find(t => nights >= t.minNights);
  return tier ? tier.percent : 0;
}

export function suggestedRooms(guests) {
  return Number(guests) >= PRICING.secondRoomFromGuests ? 2 : 1;
}

// Calcolo completo del preventivo.
// - rateOverride: se indicato, sostituisce la tariffa base di OGNI notte
//   (il supplemento della seconda camera resta quello della stagione)
// - discountPercent: se non indicato, si usa lo sconto soggiorni lunghi
// - rooms: se non indicato, si deduce dagli ospiti (3+ → 2 camere)
export function computeQuote({ checkIn, checkOut, guests = 2, rooms, rateOverride, discountPercent, withSecurityDeposit = false }) {
  const dates = nightDates(checkIn, checkOut);
  const nights = dates.length;
  const g = Math.max(1, Math.min(PRICING.maxGuests, Number(guests) || 1));
  const r = rooms ? (Number(rooms) >= 2 ? 2 : 1) : suggestedRooms(g);
  if (g >= PRICING.secondRoomFromGuests && r < 2) {
    throw new Error(`Con ${g} ospiti serve anche la seconda camera`);
  }
  const override = rateOverride !== undefined && rateOverride !== null && rateOverride !== '' ? Number(rateOverride) : null;
  if (override !== null && !(override > 0)) throw new Error('La tariffa a notte non è valida');

  // Notti raggruppate per stagione (e tariffa), nell'ordine in cui arrivano
  const groups = [];
  dates.forEach(d => {
    const s = seasonOf(d);
    const rate = override !== null ? override : s.rate;
    const extra = r === 2 ? s.secondRoomPerNight : 0;
    const last = groups[groups.length - 1];
    if (last && last.season === s.name && last.rate === rate) last.nights++;
    else groups.push({ season: s.name, rate, extra, nights: 1 });
  });

  const baseNightly = groups.reduce((t, x) => t + x.nights * x.rate, 0);
  const secondRoomNightly = groups.reduce((t, x) => t + x.nights * x.extra, 0);
  const nightlyTotal = baseNightly + secondRoomNightly;

  const disc = discountPercent === undefined || discountPercent === null || discountPercent === ''
    ? suggestedDiscount(nights) : Number(discountPercent);
  if (!(disc >= 0 && disc <= 100)) throw new Error('Lo sconto deve essere tra 0 e 100');
  const discountAmount = round2(nightlyTotal * disc / 100);
  const secondRoomOneOff = r === 2 ? PRICING.secondRoomOneOff : 0;
  const total = round2(nightlyTotal - discountAmount + secondRoomOneOff);

  const seasons = [...new Set(groups.map(x => x.season))];
  // Soggiorno minimo: non blocca il preventivo (a volte si fa un'eccezione),
  // ma l'app lo segnala
  const minNights = seasonOf(checkIn).minNights || 1;
  return {
    minNights, belowMinimum: nights < minNights,
    nights, guests: g, rooms: r, groups,
    baseNightly, secondRoomNightly, nightlyTotal,
    discountPercent: disc, discountAmount, secondRoomOneOff,
    subtotal: nightlyTotal, total,
    // tariffa media a notte (utile per statistiche e per "pari a … a notte")
    ratePerNight: round2(baseNightly / nights),
    season: seasons.length === 1 ? seasons[0] : 'Bassa e alta stagione',
    depositPercent: PRICING.depositPercent,
    depositAmount: Math.ceil(total * PRICING.depositPercent / 100),
    securityDeposit: withSecurityDeposit ? PRICING.securityDeposit : 0
  };
}

// Righe del listino in parole, per l'IA (stesse cifre del calcolo)
export function pricingKnowledge() {
  const s = PRICING.seasons.map(x => `${x.name.toLowerCase()} ${x.rate}€/notte (mesi ${x.months.join(', ')})`).join('; ');
  const extra = PRICING.seasons.map(x => `+${x.secondRoomPerNight}€/notte in ${x.name.toLowerCase()}`).join(', ');
  const ls = PRICING.longStay.slice().reverse().map(t => `${t.percent}% da ${t.minNights} notti`).join(', ');
  return [
    `- Si affitta sempre l'appartamento intero. Tariffa base con la camera padronale, fino a 2 ospiti: ${s}. La stagione si calcola notte per notte.`,
    `- Seconda camera (obbligatoria da ${PRICING.secondRoomFromGuests} ospiti, a richiesta anche per 2 ospiti che vogliono letti separati): ${extra}, più ${PRICING.secondRoomOneOff}€ una tantum per biancheria e pulizia. Senza seconda camera quella stanza resta chiusa.`,
    `- Massimo ${PRICING.maxGuests} ospiti.`,
    ...PRICING.seasons.filter(x => (x.minNights || 1) > 1).map(x => `- Soggiorno minimo in ${x.name.toLowerCase()}: ${x.minNights} notti.`),
    `- Sconto soggiorni lunghi sulla parte a notte: ${ls}.`,
    `- Per confermare: acconto del ${PRICING.depositPercent}% del totale. Per le prenotazioni dirette cauzione di ${PRICING.securityDeposit}€ con bonifico prima dell'arrivo, restituita entro ${PRICING.securityDepositRefundDays} giorni dal check-out.`
  ].join('\n');
}

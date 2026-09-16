// Calcola notti da due date. Usato per validare e per mostrare "Notti" nel PDF.
export function computeNights(checkInStr, checkOutStr) {
  const checkIn = new Date(checkInStr + 'T00:00:00');
  const checkOut = new Date(checkOutStr + 'T00:00:00');
  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    throw new Error('Date non valide');
  }
  const nights = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  if (!(nights > 0)) {
    throw new Error('Il check-out deve essere successivo al check-in');
  }
  return nights;
}

// Suggerimento automatico di tariffa (in base al mese del check-in) e sconto
// (in base alle notti) — usato solo come default pre-compilato, non vincolante.
export function suggestPricing(checkInStr, nights) {
  const checkIn = new Date(checkInStr + 'T00:00:00');
  const month = checkIn.getMonth() + 1; // 1-12
  const isAltaStagione = month >= 6 && month <= 9;
  const ratePerNight = isAltaStagione ? 150 : 80;

  let discountPercent = 0;
  if (nights >= 30) discountPercent = 30;
  else if (nights >= 7) discountPercent = 15;

  return { ratePerNight, discountPercent, season: isAltaStagione ? 'Alta stagione' : 'Bassa stagione' };
}

// Calcolo finale usato per generare davvero il preventivo: tariffa e sconto
// sono quelli confermati (eventualmente modificati a mano), non ricalcolati.
export function buildQuoteTotals({ checkIn, checkOut, ratePerNight, discountPercent }) {
  const nights = computeNights(checkIn, checkOut);

  const rate = Number(ratePerNight);
  if (!(rate > 0)) throw new Error('La tariffa a notte non è valida');

  const discount = Number(discountPercent) || 0;
  if (discount < 0 || discount > 100) throw new Error('Lo sconto deve essere tra 0 e 100');

  const { season } = suggestPricing(checkIn, nights);
  const subtotal = nights * rate;
  const discountAmount = Math.round(subtotal * discount) / 100;
  const total = subtotal - discountAmount;

  return { nights, ratePerNight: rate, season, subtotal, discountPercent: discount, discountAmount, total };
}

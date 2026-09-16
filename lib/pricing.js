// Calcola il preventivo di un soggiorno in base alle tariffe reali di Domus 106.
// Nota: la stagione viene determinata dal mese del check-in (semplificazione
// per soggiorni che iniziano e finiscono nella stessa stagione).
export function calculateQuote(checkInStr, checkOutStr) {
  const checkIn = new Date(checkInStr + 'T00:00:00');
  const checkOut = new Date(checkOutStr + 'T00:00:00');

  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    throw new Error('Date non valide');
  }

  const nights = Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  if (!(nights > 0)) {
    throw new Error('Il check-out deve essere successivo al check-in');
  }

  const month = checkIn.getMonth() + 1; // 1-12
  const isAltaStagione = month >= 6 && month <= 9;
  const ratePerNight = isAltaStagione ? 150 : 80;

  let discountPercent = 0;
  if (nights >= 30) discountPercent = 30;
  else if (nights >= 7) discountPercent = 15;

  const subtotal = nights * ratePerNight;
  const discountAmount = Math.round(subtotal * discountPercent) / 100;
  const total = subtotal - discountAmount;

  return {
    nights,
    ratePerNight,
    season: isAltaStagione ? 'Alta stagione' : 'Bassa stagione',
    subtotal,
    discountPercent,
    discountAmount,
    total
  };
}

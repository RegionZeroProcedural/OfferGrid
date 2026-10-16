export function discountPercent(price, originalPrice) {
  if (!originalPrice || originalPrice <= 0 || price >= originalPrice) return 0;
  return Math.max(0, Math.min(100, ((originalPrice - price) / originalPrice) * 100));
}

export function offerComparisonPrice(offer) {
  const item = Number(offer?.price);
  if (!Number.isFinite(item) || item <= 0) return null;

  const shipping = Number(offer?.shippingPrice);
  if (Number.isFinite(shipping) && shipping >= 0) return item + shipping;
  return item;
}

export function rescoreOffers(offers) {
  const active = offers.filter(o =>
    o.availability !== "out_of_stock" &&
    !o.priceDisplayRestricted &&
    Number(o.price) > 0
  );

  if (!active.length) return offers.map(o => ({ ...o, score: 0 }));

  const comparable = active
    .map(offerComparisonPrice)
    .filter(value => Number.isFinite(value) && value > 0);

  const lowest = comparable.length ? Math.min(...comparable) : null;
  const now = Date.now();

  return offers.map(offer => {
    if (
      offer.availability === "out_of_stock" ||
      offer.priceDisplayRestricted ||
      !Number.isFinite(Number(offer.price)) ||
      Number(offer.price) <= 0
    ) {
      return { ...offer, score: 0 };
    }

    const comparisonPrice = offerComparisonPrice(offer);
    const priceScore =
      lowest && comparisonPrice
        ? Math.min(30, (lowest / Math.max(comparisonPrice, 0.01)) * 30)
        : 0;

    const markdown = discountPercent(offer.price, offer.originalPrice);
    const discountScore = Math.min(20, (markdown / 50) * 20);

    const rate = Number(offer.commissionRate || 0);
    const commissionScore = Math.min(20, (rate / 0.10) * 20);

    let trustScore = 8;
    if (offer.merchantRatingPct != null) {
      trustScore = Math.max(
        0,
        Math.min(15, ((Number(offer.merchantRatingPct) - 85) / 15) * 15)
      );
    }

    const availabilityScore = offer.availability === "in_stock" ? 10 : 5;
    const seen = Date.parse(offer.lastSeen || 0);
    const ageHours = Number.isFinite(seen)
      ? Math.max(0, (now - seen) / 3_600_000)
      : 120;
    const freshnessScore = Math.max(0, 5 - Math.min(5, ageHours / 24));

    const accuracyAdjustment =
      String(offer.provider).toLowerCase() === "ebay"
        ? (offer.priceVerifiedAt ? 0 : -8)
        : 0;

    const score = Math.max(
      0,
      Math.round((
        priceScore +
        discountScore +
        commissionScore +
        trustScore +
        availabilityScore +
        freshnessScore +
        accuracyAdjustment
      ) * 10) / 10
    );

    return { ...offer, score, comparisonPrice };
  });
}

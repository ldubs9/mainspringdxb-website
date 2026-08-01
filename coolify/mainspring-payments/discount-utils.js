function normalizeDiscountCode(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalized) ? normalized : null;
}

function normalizeCartItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) return null;

  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const id = Number(item && item.id);
    const qty = Number((item && item.qty) || 1);
    if (!Number.isSafeInteger(id) || id <= 0 || qty !== 1 || seen.has(id)) return null;
    seen.add(id);
    normalized.push({ id, qty: 1 });
  }
  return normalized;
}

module.exports = {
  normalizeCartItems,
  normalizeDiscountCode,
};

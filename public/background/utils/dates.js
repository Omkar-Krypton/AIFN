export function parseMonthYearToISO(s) {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!t || /present/i.test(t)) return null;
  const mmYYYY = t.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  const YYYYonly = t.match(/^(\d{4})$/);
  if (!mmYYYY && !YYYYonly) return null;
  let year = 0,
    month = 1;
  if (mmYYYY) {
    const months = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const mi = months.indexOf(mmYYYY[1].toLowerCase());
    if (mi < 0) return null;
    month = mi + 1;
    year = parseInt(mmYYYY[2], 10);
  } else {
    year = parseInt(YYYYonly[1], 10);
  }
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-01`;
}

export function toIsoOrNull(v) {
  if (!v || typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return parseMonthYearToISO(t);
}

export function toIsoDateTimeOrNull(v) {
  if (!v || typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?Z$/.test(t)) return t;
  const d = toIsoOrNull(t);
  return d ? `${d}T00:00:00.000Z` : null;
}


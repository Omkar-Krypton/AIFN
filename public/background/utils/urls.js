export function normalizeUrlOrNull(u) {
  if (!u || typeof u !== "string") return null;
  const s = u.trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {}
  try {
    const url = new URL(`https://${s}`);
    return url.toString();
  } catch {}
  return null;
}

export function isValidUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}


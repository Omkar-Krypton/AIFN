// Naukri Hiring (NJP/NH) helpers.

export function extractNhIdsFromPathname(pathname) {
  const path = typeof pathname === "string" ? pathname : "";
  // Example:
  // /hiring/051225826702/apply/6932bb7bfc86cf4280449ffa
  const m = path.match(/\/hiring\/([^/]+)\/apply\/([^/?#]+)/i);
  if (!m) return { jobId: "", applicationId: "" };
  return { jobId: m[1] ? String(m[1]) : "", applicationId: m[2] ? String(m[2]) : "" };
}

export function extractApplicationIdFromNhUrl(url) {
  const u = typeof url === "string" ? url : "";
  // .../applications/<applicationId>...
  const m = u.match(/\/applications\/([^/?#]+)/i);
  return m && m[1] ? String(m[1]) : "";
}

export function isNhApplicationDetailApi(url) {
  const u = typeof url === "string" ? url : "";
  return (
    u.includes("hiring.naukri.com") &&
    u.includes("rm-application-detail-services") &&
    u.includes("/applications/") &&
    !u.includes("/contact-details")
  );
}

export function isNhContactDetailsApi(url) {
  const u = typeof url === "string" ? url : "";
  return (
    u.includes("hiring.naukri.com") &&
    u.includes("rm-application-detail-services") &&
    u.includes("/contact-details")
  );
}

export function isNhResumeDownloadApi(url) {
  const u = typeof url === "string" ? url : "";
  return u.includes("hiring.naukri.com") && u.includes("rm-document-services") && u.includes("/download/applications/");
}


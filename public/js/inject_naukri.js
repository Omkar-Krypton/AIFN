(function naukriMainWorldInject() {
  "use strict";

  // MAIN-world script: prepare resume URL only (no network call here).
  // The content script performs the actual XHR/fetch so DevTools Initiator is the content script.
  if (window.__naukri_main_world_inject_installed) return;
  window.__naukri_main_world_inject_installed = true;

  const RESUME_BASE =
    "https://resdex.naukri.com/cloudgateway-resdex/recruiter-js-profile-services/v0";

  function parseCompanyRecruiterFromUrl(url) {
    if (!url || typeof url !== "string") return { companyId: null, recruiterId: null };
    const m = url.match(/companies\/(\d+)\/recruiters\/(\d+)/i);
    if (!m) return { companyId: null, recruiterId: null };
    return { companyId: m[1], recruiterId: m[2] };
  }

  function ensureRmfileInput() {
    let rm = document.getElementById("rmfile");
    if (rm) return rm;
    rm = document.createElement("input");
    rm.type = "hidden";
    rm.id = "rmfile";
    (document.documentElement || document.body || document.head).appendChild(rm);
    return rm;
  }

  function buildResumeUrl(profile, companyId, recruiterId) {
    if (!profile || !companyId || !recruiterId) return null;
    const nowEpoch = Math.floor(Date.now() / 1000);

    const resId = profile.encryptedResId || profile.encryptedUserResmanId || "";
    const uname = profile.doubleEncryptedUserName || "";
    if (!resId || !uname) return null;

    let url =
      RESUME_BASE +
      "/companies/" +
      companyId +
      "/recruiters/" +
      recruiterId +
      "/jsprofile/download/resume?AT=" +
      nowEpoch +
      "&resId=" +
      encodeURIComponent(resId) +
      "&uname=" +
      encodeURIComponent(uname);

    // Optional params if present (keeps compatibility with some flows).
    if (profile.searchParamStr) url += "&searchParamStr=" + encodeURIComponent(profile.searchParamStr);
    if (profile.sid != null) url += "&sid=" + encodeURIComponent(String(profile.sid));

    return url;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data || {};
    if (msg.source !== "AIFN_EXTENSION" || msg.type !== "PREPARE_RESUME_URL") return;

    const profile = msg.profile;
    const jsprofileUrl = msg.jsprofileUrl || "";
    const { companyId, recruiterId } = parseCompanyRecruiterFromUrl(jsprofileUrl);
    const resumeUrl = buildResumeUrl(profile, companyId, recruiterId);
    if (!resumeUrl) return;

    const rm = ensureRmfileInput();
    rm.value = resumeUrl;
    rm.setAttribute("data-aifn-ready", "true");
  });
})();

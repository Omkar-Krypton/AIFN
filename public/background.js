import { getStoredAuth } from "./background/core/auth.js";
import { ETICA_EXT_URL, PROFILE_API_URL, WEB_APP_URL } from "./config/constants.js";
import {
  extractNhIdsFromPathname,
  extractApplicationIdFromNhUrl,
  isNhApplicationDetailApi,
  isNhContactDetailsApi,
  isNhResumeDownloadApi,
} from "./background/njp/ids.js";
import { extractCvUpdatedAtFromNhApplication } from "./background/njp/payload.js";
import { handleSjbProfile, handleSjbUpdateResume, handleCheckSjbIds } from "./background/sjb/handlers.js";
import { handleCheckCanScrape } from "./background/core/rateLimit.js";
import {
  handleImportSession as handleImportSessionCross,
  handleExportSession as handleExportSessionCross,
  handleLogoutAndClearData as handleLogoutAndClearDataCross,
  getDomain as getDomainCross,
} from "./background/core/sessionImport.js";

// -----------------------------------------------------------------------------
// Duplicate extension + Naukri host conflict checks
// -----------------------------------------------------------------------------

// The specific job-board hosts this extension actively intercepts.
// Only another extension that targets at least one of these (and is enabled)
// is a real conflict.
const OUR_JOB_BOARD_HOSTS = [
  "resdex.naukri.com",
  "hiring.naukri.com",
  "recruiter.shine.com",
  "shine.com",
];

// Returns true if the given extension's hostPermissions overlap with ours
// AND the extension is enabled (disabled extensions cannot conflict).
function isConflictingExtension(ext, myId) {
  if (!ext || ext.id === myId) return false;
  if (!ext.enabled) return false;

  const perms = Array.isArray(ext.hostPermissions) ? ext.hostPermissions : [];
  return OUR_JOB_BOARD_HOSTS.some((host) =>
    perms.some((p) => typeof p === "string" && p.includes(host))
  );
}

// A true duplicate is same name + same id-independent fingerprint: overlapping
// job-board hosts AND enabled. Matching by name alone is unreliable (name is
// user-visible and can be identical across unrelated extensions).
function isDuplicateExtension(ext, myId, myName) {
  if (!ext || ext.id === myId) return false;
  if (ext.name !== myName) return false;
  // Must also share at least one of our specific job-board hosts to count.
  return isConflictingExtension(ext, myId);
}

// Detect if another copy of this extension is installed; store conflict flag.
function checkDuplicateExtension() {
  if (!chrome?.management?.getAll) return;
  chrome.management.getAll((extensions) => {
    const name = chrome.runtime.getManifest().name;
    const myId = chrome.runtime.id;
    const duplicates = (extensions || []).filter((e) => isDuplicateExtension(e, myId, name));
    if (duplicates.length > 0) {
      chrome.storage.local.set({ conflict: true, otherExtension: duplicates[0].id });
    } else {
      chrome.storage.local.set({ conflict: false });
    }
  });
}

// Run duplicate check + conflict check; sendResponse({ conflict, naukriConflicts })
function handleCheckDuplicate(sendResponse) {
  if (!chrome?.management?.getAll) {
    sendResponse({ conflict: false, naukriConflicts: [] });
    return true;
  }

  chrome.management.getAll((extensions) => {
    const name = chrome.runtime.getManifest().name;
    const myId = chrome.runtime.id;

    // Strict dupe: same name + overlapping hosts + enabled.
    const conflict = (extensions || []).some((e) => isDuplicateExtension(e, myId, name));

    // Conflict: different extension, enabled, shares our specific job-board hosts.
    // Exclude duplicates from this list (they are already covered by `conflict`).
    const naukriConflicts = (extensions || [])
      .filter((e) => !isDuplicateExtension(e, myId, name) && isConflictingExtension(e, myId))
      .map((e) => ({ id: e.id, name: e.name, enabled: e.enabled }));

    sendResponse({ conflict, naukriConflicts: naukriConflicts || [] });
  });
  return true; // keep message channel open for async sendResponse
}

chrome.runtime.onStartup.addListener(checkDuplicateExtension);
chrome.runtime.onInstalled.addListener(() => {
  checkDuplicateExtension();
});

const VERIFIED_IDS_API_URL = `${PROFILE_API_URL}/candidates/verified-ids`;

const CANDIDATES_API_URL = `${PROFILE_API_URL}/candidates`;

const UPLOAD_RESUME_API_URL = `${PROFILE_API_URL}/candidates/upload-resume`;

// MV3 service workers disallow top-level await. Cache the token and refresh it
// on startup + when storage changes.
let authTokenCache = "";
let authInitPromise = null;

function getAuthToken() {
  return authTokenCache ? String(authTokenCache) : "";
}

function getBearerAuthHeaderValue() {
  const token = getAuthToken();
  return token ? `Bearer ${token}` : "";
}

function isLoggedIn() {
  return Boolean(getAuthToken());
}

async function ensureAuthTokenLoaded() {
  if (authInitPromise) return authInitPromise;
  authInitPromise = (async () => {
    try {
      const { storedToken } = await getStoredAuth();
      authTokenCache = storedToken ? String(storedToken) : "";
    } catch (e) {
      // Keep service worker alive even if storage read fails.
      console.error("[Background] Failed to load auth token:", e);
      authTokenCache = "";
    }
  })();
  return authInitPromise;
}

// Fire-and-forget init.
ensureAuthTokenLoaded();

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes || !Object.prototype.hasOwnProperty.call(changes, "authToken")) return;
    authTokenCache = changes.authToken?.newValue ? String(changes.authToken.newValue) : "";
  });
}

// Resume uploads must use the backend UUID returned by POST /candidates.
// We buffer resumes until that UUID is known.

let lastListingSignature = null;
let lastNjbVerifiedIdsPayload = null; // { signature, body }

// Profile page (preview) needs 2 API responses before sending /candidates:
// 1) recruiter-js-profile-services (profile)
// 2) contactdetails (contact info)
const profileByUserId = new Map(); // userId -> profile response
const contactByUserId = new Map(); // userId -> contactdetails response
const lastSentCandidatesSignatureByUserId = new Map(); // userId -> signature

// Used for resume upload correlation (resume API doesn't include IDs reliably).
let latestPreviewUserId = null;
let latestPreviewUniqueId = null;
let latestPreviewTabId = null;

// Map preview tab id to naukri userId so we can show preview-page badge
// after candidate is saved.
const previewTabIdByUserId = new Map(); // userId -> tabId

// backendCandidateId (UUID) keyed by naukri userId (string)
const backendCandidateIdByUserId = new Map();

// Buffer resume until we know backend candidate UUID.
const pendingResumeByUserId = new Map(); // userId -> { cvBuffer, cv_updated_at }

// Used for customer-candidate mapping API after resume upload completes.
const mappingDataByUserId = new Map(); // userId -> { customerId, scrappedBy, candidateId }
const mappingDoneByCandidateId = new Set(); // candidateId -> true

// --------------------------------------------------------------------------------------
// NJP / NH (Naukri Hiring) state
// We only scrape on detail pages (/hiring/<jobId>/apply/<applicationId>).
// --------------------------------------------------------------------------------------
const nhAppDetailByApplicationId = new Map(); // applicationId -> application detail JSON
const nhContactByApplicationId = new Map(); // applicationId -> contact-details JSON
const nhResumeByApplicationId = new Map(); // applicationId -> { cvBuffer, cv_updated_at }
const nhBackendCandidateIdByApplicationId = new Map(); // applicationId -> backend candidate UUID
const nhTabIdByApplicationId = new Map(); // applicationId -> tabId for ✓ badge
const nhLastSentSignatureByApplicationId = new Map(); // applicationId -> signature string (dedupe)

async function handleApiInterceptorMessage(msg, sender) {
  // console.log("🔔 Background received message:", msg?.url);
  await ensureAuthTokenLoaded();
  if (!isLoggedIn()) return;

  // const isJsProfileApi =
  //   typeof msg.url === "string" &&
  //   (msg.url.includes("recruiter-js-profile-services") ||
  //     msg.url.includes("candidates") || msg.url.includes("contactdetails")) &&
  //   msg.data &&
  //   msg.data.uniqueId;

  // Profile page API: recruiter-js-profile-services AND preview route
  const isRecruiterJsProfileService =
    typeof msg.url === "string" && msg.url.includes("recruiter-js-profile-services");
  const isContactDetailsApi =
    typeof msg.url === "string" && msg.url.includes("contactdetails");
  const isPreviewPage =
    typeof msg.pathname === "string" && msg.pathname.includes("preview");

  const isJsProfileApi = isRecruiterJsProfileService && isPreviewPage;
  const isContactDetailsOnPreview = isContactDetailsApi && isPreviewPage;

  const isResumeApi =
    typeof msg.url === "string" &&
    (msg.url.includes("/jsprofile/download/resume") ||
      msg.url.includes("jsprofile/download/resume") ||
      isNhResumeDownloadApi(msg.url));
  // Search results (tuples) can be intercepted while still on advSrch; accept whenever we have tuples.
  const hasTuples = Array.isArray(msg?.data?.tuples);
  if (hasTuples) return sendListingCandidatesData(msg.data);

  if (isResumeApi) {
    const cvBuffer = typeof msg?.data?.cvBuffer === "string" ? msg.data.cvBuffer : "";
    if (!cvBuffer) {
      console.log("⏭️  Resume API detected but cvBuffer missing");
      return;
    }

    // NH (Naukri Hiring) resume: correlate by applicationId from pathname/data.
    if (isNhResumeDownloadApi(msg.url)) {
      const fromDataAppId = msg?.data?.nh_applicationId ? String(msg.data.nh_applicationId) : "";
      const fromPath = extractNhIdsFromPathname(msg?.pathname || "");
      const applicationId = fromDataAppId || fromPath.applicationId || "";
      if (!applicationId) {
        console.log("⏭️  [NH] Resume captured but applicationId missing");
        return;
      }

      const appDetail = nhAppDetailByApplicationId.get(String(applicationId));
      const cv_updated_at = extractCvUpdatedAtFromNhApplication(appDetail || {});

      const backendCandidateId = nhBackendCandidateIdByApplicationId.get(String(applicationId)) || null;
      if (!backendCandidateId) {
        nhResumeByApplicationId.set(String(applicationId), { cvBuffer, cv_updated_at });
        console.log("⏳ [NH] Resume buffered (waiting backend candidate_id)", { applicationId });
        return;
      }

      return uploadResume(
        {
          candidate_id: String(backendCandidateId),
          cvBuffer,
          cv_updated_at,
        },
        {
          userId: appDetail?.jobSeekerUserId ? String(appDetail.jobSeekerUserId) : String(applicationId),
          job_board: "NH",
        }
      );
    }

    const userIdKey = latestPreviewUserId ? String(latestPreviewUserId) : null;
    const backendCandidateId = userIdKey ? backendCandidateIdByUserId.get(userIdKey) : null;

    if (!backendCandidateId) {
      const profileData = userIdKey ? profileByUserId.get(userIdKey) : null;
      const cv_updated_at = getCvUpdatedAtForResume(profileData);

      if (userIdKey) {
        pendingResumeByUserId.set(String(userIdKey), { cvBuffer, cv_updated_at });
      }

      console.log("⏳ Resume buffered (waiting backend candidate_id)");
      return;
    }

    const profileData = userIdKey ? profileByUserId.get(userIdKey) : null;
    const cv_updated_at = getCvUpdatedAtForResume(profileData);

    return uploadResume(
      {
      candidate_id: backendCandidateId,
      cvBuffer,
      // Backend expects YYYY-MM-DD (string) or null
      cv_updated_at,
      },
      { userId: userIdKey, job_board: "NJ" }
    );
  }

  // ------------------------------------------------------------------------------------
  // NH / NJP: hiring.naukri.com detail page flow
  // ------------------------------------------------------------------------------------
  if (isNhApplicationDetailApi(msg?.url)) {
    const applicationId = extractApplicationIdFromNhUrl(msg.url);
    if (!applicationId) return;
    if (sender?.tab?.id) nhTabIdByApplicationId.set(String(applicationId), sender.tab.id);

    nhAppDetailByApplicationId.set(String(applicationId), msg.data);
    return maybeSendNhCombinedCandidate(String(applicationId));
  }

  if (isNhContactDetailsApi(msg?.url)) {
    const applicationId = extractApplicationIdFromNhUrl(msg.url);
    if (!applicationId) return;
    if (sender?.tab?.id) nhTabIdByApplicationId.set(String(applicationId), sender.tab.id);

    nhContactByApplicationId.set(String(applicationId), msg.data);
    return maybeSendNhCombinedCandidate(String(applicationId));
  }

  if (isContactDetailsOnPreview) {
    const userId = msg?.data?.userId;
    if (!userId) {
      // console.log("⏭️  Contactdetails missing userId");
      return;
    }

    latestPreviewUserId = String(userId);
    if (sender?.tab?.id) {
      latestPreviewTabId = sender.tab.id;
      previewTabIdByUserId.set(String(userId), sender.tab.id);
    }
    contactByUserId.set(String(userId), msg.data);
    // console.log("✅ CONTACT DETAILS FOUND (background):", { userId, email: msg?.data?.email });

    return maybeSendCombinedCandidateToCandidatesApi(String(userId));
  }

  if (!isJsProfileApi) {
    // console.log("⏭️  Skipping: doesn't match criteria. URL:", msg.url, "Has uniqueId:", !!msg.data?.uniqueId);
    return;
  }

  // console.log("✅ JS PROFILE DATA FOUND (background):", msg.data);

  // 🔥 Send data to backend from the background service worker
  //sendCandidateData(msg.data);

  const profileUserId = msg?.data?.userId;
  if (profileUserId) {
    latestPreviewUserId = String(profileUserId);
    latestPreviewUniqueId = msg?.data?.uniqueId ? String(msg.data.uniqueId) : latestPreviewUniqueId;
    if (sender?.tab?.id) {
      latestPreviewTabId = sender.tab.id;
      previewTabIdByUserId.set(String(profileUserId), sender.tab.id);
    }
    profileByUserId.set(String(profileUserId), msg.data);
    return maybeSendCombinedCandidateToCandidatesApi(String(profileUserId));
  }

  console.log("⏭️  Profile response missing userId, cannot merge with contacts");
}

// Listen for messages from popup + content scripts.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    // IMPORTANT: this must run even when logged out (popup opens before login).
    if (message?.action === "checkDuplicate") {
      return handleCheckDuplicate(sendResponse);
    }

    // If not logged in, do not do any work for automatic pipelines.
    // Allow a small set of utility actions to still function.
    if (message?.source === "API_INTERCEPTOR") {
      // Interceptor pipeline (contentScript -> background).
      handleApiInterceptorMessage(message, sender);
      return;
    }

    const allowedWithoutLogin =
      message?.type === "PING" ||
      message?.action === "updateUninstallURL" ||
      message?.action === "getDomain";

    if (!isLoggedIn() && !allowedWithoutLogin) {
      // Do nothing when logged out.
      try {
        sendResponse?.({ ok: false, error: "Not logged in" });
      } catch {
        // ignore
      }
      return true;
    }

    // Popup/background protocol (ported from Working_extension).
    if (message?.type === "PING") {
      sendResponse({ status: "ready", timestamp: Date.now() });
      return true;
    }

    // Rate-limit gate used by Shine (SJ) content scripts (ported from Working_extension).
    if (message?.type === "CHECK_CAN_SCRAPE") {
      return handleCheckCanScrape(message, sender, sendResponse);
    }

    // Shine (SJ) scraping + resume upload pipeline (ported from Working_extension).
    if (message?.type === "SJB_PROFILE") {
      handleSjbProfile(message, sender, sendResponse);
      return true;
    }
    if (message?.type === "SJB_UPDATE_RESUME") {
      handleSjbUpdateResume(message, sender, sendResponse);
      return true;
    }
    if (message?.action === "CHECK_SJB_IDS") {
      handleCheckSjbIds(message, sendResponse);
      return true;
    }

    // Content script on /v3/search (load, reload, or SPA nav from advSrch) asks to refresh verified-ids.
    if (message?.action === "REQUEST_NJB_VERIFIED_IDS_REFRESH") {
      (async () => {
        try {
          if (lastNjbVerifiedIdsPayload?.body) {
            await postVerifiedIdsAndBroadcast(lastNjbVerifiedIdsPayload.body, true);
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
      })();
      return true; // async
    }

    // Verified-IDs / badge support (ported from Working_extension).
    // Content scripts call this on every /v3/search load + route change.
    if (message?.action === "CHECK_NJB_PROFILES") {
      handleCheckNjbProfiles(message, sendResponse);
      return true; // async response
    }

    if (message?.action === "shareSession") {
      handleExportSessionCross(sendResponse);
      return true;
    }
    if (message?.action === "importSession") {
      handleImportSessionCross(message.sessionData, sendResponse);
      return true;
    }
    if (message?.action === "logout") {
      handleLogoutAndClearDataCross(sendResponse);
      return true;
    }
    if (message?.action === "updateUninstallURL") {
      try {
        const token = message?.token ? String(message.token) : "";
        if (token) {
          const uninstallUrl = `${WEB_APP_URL}/extension/uninstall?token=${encodeURIComponent(token)}`;
          chrome.runtime.setUninstallURL(uninstallUrl, () => {
            if (chrome.runtime.lastError) {
              console.error("[Background] Failed to update uninstall URL:", chrome.runtime.lastError);
            }
          });
        }
      } catch (e) {
        // ignore
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.action === "getDomain") {
      getDomainCross(sendResponse);
      return true;
    }
  } catch (error) {
    sendResponse({ error: error?.message || String(error) });
    return false;
  }
});

function tryExtractUuidFromCandidatesResponseText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function fetchMappingUserInfo() {
  await ensureAuthTokenLoaded();
  const authHeader = getBearerAuthHeaderValue();
  if (!authHeader) return { customerId: "", scrappedBy: "" };

  const userResponse = await fetch(`${ETICA_EXT_URL}/profile/me`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
  }).catch(() => null);

  if (!userResponse || !userResponse.ok) return { customerId: "", scrappedBy: "" };

  const userData = await userResponse.json().catch(() => ({}));

  return {
    scrappedBy: userData?.data?.data?._id || userData?.data?._id || "",
    customerId: userData?.data?.data?.customerId || userData?.data?.customerId || "",
  };
}

async function postCustomerCandidateMapping(mapData) {
  await ensureAuthTokenLoaded();
  const authHeader = getBearerAuthHeaderValue();
  if (!authHeader) return;

  await fetch(`${ETICA_EXT_URL}/customer-candidate-mapping`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(mapData),
  }).catch(() => null);
}

async function maybeMapCustomerToCandidateAfterResumeUpload(userId, candidateId, jobBoard) {
  try {
    const uid = userId ? String(userId) : "";
    const cid = candidateId ? String(candidateId) : "";
    if (!uid || !cid) return;
    if (mappingDoneByCandidateId.has(cid)) return;

    let current = mappingDataByUserId.get(uid) || null;
    if (!current || current.candidateId !== cid) {
      current = { customerId: "", scrappedBy: "", candidateId: cid };
    }

    if (!current.customerId || !current.scrappedBy) {
      const info = await fetchMappingUserInfo();
      current.customerId = current.customerId || info.customerId;
      current.scrappedBy = current.scrappedBy || info.scrappedBy;
    }

    // Persist so later resume retries don't have to refetch /profile/me.
    mappingDataByUserId.set(uid, current);

    if (!current.customerId || !current.scrappedBy) return;

    await postCustomerCandidateMapping({
      customerId: current.customerId,
      candidateId: current.candidateId,
      scrappedBy: current.scrappedBy,
      job_board: jobBoard ? String(jobBoard) : "NJ",
    });

    mappingDoneByCandidateId.add(cid);
  } catch (e) {
    console.error("[Background] Mapping API error:", e);
  }
}

async function uploadResume(data, opts = {}) {
  try {
    await ensureAuthTokenLoaded();
    const res = await fetch(UPLOAD_RESUME_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        Authorization: getBearerAuthHeaderValue(),
      },
      body: JSON.stringify(data),
    });

    const resultText = await res.text();
    console.log("✅ Uploaded resume to backend:", { status: res.status, candidate_id: data?.candidate_id });
    // console.log("upload-resume response body:", resultText);

    if (res.ok) {
      await maybeMapCustomerToCandidateAfterResumeUpload(opts?.userId, data?.candidate_id, opts?.job_board);
    }
  } catch (err) {
    console.error("❌ Failed to upload resume:", err);
  }
}

async function maybeSendNhCombinedCandidate(applicationId) {
  try {
    const appId = applicationId ? String(applicationId) : "";
    if (!appId) return;

    const appDetail = nhAppDetailByApplicationId.get(appId);
    const contactDetails = nhContactByApplicationId.get(appId);

    if (!appDetail || !contactDetails) {
      return;
    }

    // Dedupe only within a short window to avoid double posts from rapid duplicate intercepts,
    // but allow reload/rehydration to run again.
    const signature = [
      appDetail?.jobSeekerUserId || "",
      appDetail?.jobId || "",
      appDetail?.applicationId || "",
      Array.isArray(contactDetails?.email) ? (contactDetails.email[0]?.value || "") : "",
      Array.isArray(contactDetails?.phoneNumber) ? (contactDetails.phoneNumber[0]?.value || "") : "",
    ].join("|");

    const now = Date.now();
    const lastMeta = nhLastSentSignatureByApplicationId.get(appId);
    if (lastMeta?.signature === signature && typeof lastMeta?.atMs === "number" && now - lastMeta.atMs < 1200) {
      return;
    }
    nhLastSentSignatureByApplicationId.set(appId, { signature, atMs: now });

    await ensureAuthTokenLoaded();

    // Convert Hiring APIs -> "profile-like" + "contactdetails-like" so we reuse the
    // existing Naukri mapper and keep the exact same payload keys/schema.
    const firstEmail = Array.isArray(contactDetails?.email) ? String(contactDetails.email[0]?.value || "") : "";
    const phoneValues = Array.isArray(contactDetails?.phoneNumber)
      ? contactDetails.phoneNumber.map((p) => String(p?.value || "")).filter(Boolean)
      : [];

    const contactLike = {
      email: firstEmail || "",
      parsedPhoneNos: phoneValues.map((num) => ({ number: num, type: "M" })),
      phoneNo: phoneValues[0] || "",
    };

    const ctcAbs = Number(appDetail?.ctc?.absolute || 0);
    const expCtcAbs = Number(appDetail?.expectedCtc?.absolute || 0);

    const workExperiences = Array.isArray(appDetail?.workExp) ? appDetail.workExp : [];
    const educations = Array.isArray(appDetail?.education) ? appDetail.education : [];
    const languages = Array.isArray(appDetail?.languages) ? appDetail.languages : [];

    const profileLike = {
      name: appDetail?.name || "",
      email: firstEmail || "",
      userId: appDetail?.jobSeekerUserId ? String(appDetail.jobSeekerUserId) : "",
      city: appDetail?.currentCity || "",
      prefLocation: appDetail?.preferredLocations || "",
      keywords: appDetail?.keySkills || "",
      displayKeywords: appDetail?.mayAlsoKnowSkills || "",
      jobTitle: appDetail?.profileSummary || appDetail?.role || "",
      summary: appDetail?.summary || "",
      role: appDetail?.role || "",
      industryType: appDetail?.industry || "",
      // NH: treat 99 as placeholder and send 0; format as "Xy Ym" (e.g. 3 years 6 months → "3y 6m")
      totalExperience: (() => {
        const y = appDetail?.experience?.years;
        if (y == null) return "";
        if (y === 99) return "0";
        const years = Number(y) || 0;
        const months = Number(appDetail?.experience?.months) || 0;
        const parts = [];
        if (years > 0) parts.push(`${years}y`);
        if (months > 0) parts.push(`${months}m`);
        return parts.length ? parts.join(" ") : "0";
      })(),
      rawTotalExperience: (() => {
        const y = appDetail?.experience?.years;
        if (y == null) return "";
        if (y === 99) return "0";
        const years = Number(y) || 0;
        const months = Number(appDetail?.experience?.months) || 0;
        const parts = [];
        if (years > 0) parts.push(`${years}y`);
        if (months > 0) parts.push(`${months}m`);
        return parts.length ? parts.join(" ") : "0";
      })(),
      noticePeriod: appDetail?.noticePeriod || "",
      empStatus: appDetail?.isCurrentlyUnemployed ? "unemployed" : "",
      jobType: "",
      // Resdex mapper expects lakhs for INR (value * 100000 = absolute)
      ctcType: "INR",
      rawCtc: ctcAbs > 0 ? String(ctcAbs / 100000) : "",
      ctcValue: ctcAbs > 0 ? String(ctcAbs / 100000) : "",
      expectedCtcType: "INR",
      rawExpectedCtc: expCtcAbs > 0 ? String(expCtcAbs / 100000) : "",
      expectedCtcValue: expCtcAbs > 0 ? String(expCtcAbs / 100000) : "",
      birthDate: appDetail?.otherDetails?.personal?.dob || "",
      gender: appDetail?.otherDetails?.personal?.gender || "",
      maritalStatus: appDetail?.otherDetails?.personal?.maritalStatus || "",
      // NH: desired job details
      jobType: appDetail?.otherDetails?.desiredJD?.jobType || "",
      empStatus: appDetail?.otherDetails?.desiredJD?.employerStatus || (appDetail?.isCurrentlyUnemployed ? "unemployed" : ""),
      // NH: affirmative / caste
      caste: appDetail?.otherDetails?.affirmative?.category || "",
      physicallyChallenged: appDetail?.otherDetails?.affirmative?.physicallyChallenged || "",
      // NH: address
      addressWithPin: appDetail?.otherDetails?.address?.addressWithPin || "",
      homeTown: appDetail?.otherDetails?.address?.homeTown || "",
      modifiedDate: appDetail?.addedOn ? String(appDetail.addedOn).slice(0, 10) : "",
      viewDate: appDetail?.lastActiveOnResdex ? String(appDetail.lastActiveOnResdex).slice(0, 10) : "",
      // Shapes expected by mapper:
      workExperiences: workExperiences.map((we) => {
        const isCurrent = String(we?.current || "") === "1" || we?.workingTo == null;
        return {
          organization: we?.company || "",
          designation: we?.designation || "",
          profile: we?.jobProfile || "",
          startDate: we?.workingFrom || "",
          endDate: isCurrent ? "Till Date" : (we?.workingTo || ""),
          empTypeLable: isCurrent ? "Current" : "",
          startYearMillis: null,
          endYearMillis: null,
        };
      }),
      educations: educations.map((ed) => {
        const degreeType = (ed?.degreeType || "").toString().toLowerCase();
        const isPg = degreeType.includes("post");
        return {
          educationTypeId: isPg ? 2 : 1,
          course: { label: ed?.degree || "" },
          spec: { label: ed?.specialization || "" },
          institute: { label: ed?.institute || "" },
          entityInstitute: { label: ed?.institute || "" },
          yearOfCompletion: ed?.year != null ? String(ed.year) : "",
        };
      }),
      languages: languages.map((l) => {
        const parts = [];
        if (l?.canRead) parts.push("read");
        if (l?.canWrite) parts.push("write");
        if (l?.canSpeak) parts.push("speak");
        return {
          lang: l?.language || "",
          proficiency: { label: l?.proficiency || "" },
          ability: parts.join(" "),
        };
      }),
      // NH: candidateProjects → same shape as Resdex projects for mapper
      projects: (Array.isArray(appDetail?.candidateProjects) ? appDetail.candidateProjects : []).map((p) => ({
        project: p?.project || "",
        client: p?.client || "",
        site: p?.site || "",
        details: p?.projectDetails || "",
        role: p?.employmentType || p?.employmentNature || "",
        employmentNature: p?.employmentType || p?.employmentNature || "",
        skills: p?.skill || "",
        startDate: p?.startDate || "",
        endDate: p?.endDate || "",
        startYearMillis: null,
        endYearMillis: null,
      })),
      certifications: [],
      // NH skills: array of { skillLabel, experienceYear, experienceMonth } → same shape as Resdex for mapper (Key Skills / IT Skills / May Also Know)
      skills: (Array.isArray(appDetail?.skills) ? appDetail.skills : []).map((s) => {
        const y = s?.experienceYear != null ? Number(s.experienceYear) : null;
        const m = s?.experienceMonth != null ? Number(s.experienceMonth) : null;
        let experienceTimeLable = "";
        if (typeof y === "number" && !Number.isNaN(y) && y > 0) {
          experienceTimeLable = m && !Number.isNaN(m) && m > 0 ? `${y}.${m}y` : `${y}y`;
        }
        return {
          skill: { label: s?.skillLabel || "" },
          experienceTimeLable,
        };
      }),
    };

    const payload = mapProfileResponseToCandidatesPayload(profileLike, contactLike);
    payload.source = "NH";
    // NH does not provide desired position or functional area; do not send them.
    if (payload.job_preference) {
      payload.job_preference.desired_job_type = { job_type: "", employment_status: "" };
    }
    if (payload.professional_summary) {
      payload.professional_summary.department = "";
    }

    const res = await fetch(CANDIDATES_API_URL, {
        method: "POST",
        headers: {
        accept: "*/*",
        Authorization: getBearerAuthHeaderValue(),
          "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();

    // Capture backend candidate UUID (same multi-shape parsing as NJB).
    let candidateId = null;
    try {
      const parsed = JSON.parse(resultText);
      candidateId =
        parsed?.data?.data?.profile?.id ||
        parsed?.data?.profile?.id ||
        parsed?.data?.id ||
        parsed?.candidate?.id ||
        parsed?.id ||
        null;
    } catch {
      // ignore
    }

    if (!candidateId) candidateId = tryExtractUuidFromCandidatesResponseText(resultText);

    if (candidateId) {
      nhBackendCandidateIdByApplicationId.set(appId, String(candidateId));

      // If resume was captured earlier, upload it now.
      const pending = nhResumeByApplicationId.get(appId);
      if (pending?.cvBuffer) {
        nhResumeByApplicationId.delete(appId);
        await uploadResume(
          {
            candidate_id: String(candidateId),
            cvBuffer: pending.cvBuffer,
            cv_updated_at: pending.cv_updated_at || null,
          },
          {
            // Use jobSeekerUserId for mapping identity (stable across applications).
            userId: appDetail?.jobSeekerUserId ? String(appDetail.jobSeekerUserId) : appId,
            job_board: "NH",
          }
        );
      }

      // Paint ✓ on the Hiring details page. Catch sendMessage rejection (tab may have no content script).
      const tabId = nhTabIdByApplicationId.get(appId);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: "NH_DETAIL_BADGE", candidateId: String(candidateId) }).catch(() => {});
      }
    }

    // Keep log light; avoid dumping full payload.
    console.log("✅ [NH] Sent candidate to /candidates:", { status: res.status, applicationId: appId });
  } catch (err) {
    console.error("❌ [NH] Failed to send candidate to /candidates:", err);
  }
}

function getCvUpdatedAtForResume(profileData) {
  // Prefer cvAccessDate if available (it reflects resume access/update)
  if (profileData?.cvAccessDate) {
    return toIsoDateString(String(profileData.cvAccessDate));
  }
  if (profileData?.modifiedDate) {
    // already YYYY-MM-DD in Naukri payloads
    return String(profileData.modifiedDate);
  }
  return formatLocalDateString(new Date());
}

// async function sendCandidateData(data) {
//   try {
//     const res = await fetch(
//       "http://localhost:5001/api/candidate-intercept-data",
//       {
//         method: "POST",
//         headers: {
//           "Content-Type": "application/json",
//           accept: "application/json",
//         },
//         body: JSON.stringify(data),
//       }
//     );

//     const result = await res.json();
//     console.log("✅ Sent to backend (background):", result);
//   } catch (err) {
//     console.error("❌ Failed to send candidate data (background):", err);
//   }
// }

/** Format a Date as YYYY-MM-DD using local date (avoids UTC off-by-one). */
function formatLocalDateString(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toIsoDateString(input) {
  if (!input || typeof input !== "string") return "";
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  return formatLocalDateString(d);
}

function calcAgeFromIsoDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return String(age);
}

function splitCommaValues(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "2 Months" -> "2M", "1 Month" -> "1M" */
function abbreviateNoticePeriod(np) {
  if (!np || typeof np !== "string") return "";
  const s = np.trim();
  const m = s.match(/^(\d+)\s*month(s)?$/i);
  if (m) return m[1] + "M";
  return s;
}

/** Millis to YYYY-MM-DD (local date); null/0 -> null */
function millisToIsoDate(millis) {
  if (millis == null || millis === 0) return null;
  const d = new Date(Number(millis));
  if (Number.isNaN(d.getTime())) return null;
  return formatLocalDateString(d);
}

/** Format CTC for display: ctcType USD + ctcValue 0.80 -> "$ 80,000"; INR Lacs -> "₹ 80,000" */
function formatCtcDisplay(profile) {
  const raw = profile?.rawCtc || profile?.ctcValue || "";
  const type = (profile?.ctcType || "").toUpperCase();
  if (!raw) return "";
  const num = parseFloat(String(raw).replace(/[^\d.]/g, ""), 10);
  if (Number.isNaN(num)) return profile?.ctc || "";
  if (type === "USD") {
    const val = Math.round(num * 100000);
    return "$ " + val.toLocaleString("en-IN");
  }
  if (type === "INR") {
    const val = Math.round(num * 100000);
    return "₹ " + val.toLocaleString("en-IN");
  }
  return profile?.ctc || "";
}

/** Build headline from current work: "Designation  at  Organization  since StartDate" */
function buildHeadline(profile) {
  const work = Array.isArray(profile?.workExperiences) ? profile.workExperiences : [];
  const current = work.find(
    (w) =>
      (w?.empTypeLable || "").toLowerCase().includes("current") ||
      (w?.endDate || "").toLowerCase().includes("till")
  );
  if (!current) return profile?.jobTitle || "";
  const designation = current.designation || "";
  const organization = current.organization || "";
  const since = current.startDate || "";
  const parts = [designation, organization, since].filter(Boolean);
  if (parts.length === 0) return profile?.jobTitle || "";
  return designation + "  at  " + organization + "  since " + since;
}

function sanitizePhoneNumber(value) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/[^\d]/g, "");
}

/** Normalize to display form: strip leading 91 (India) so 9107314205954 -> 07314205954; keep others as-is. */
function normalizePhoneForDisplay(digits) {
  if (!digits) return "";
  if (digits.length > 10 && digits.startsWith("91")) return digits.slice(2);
  return digits;
}

function extractContactDetailsContacts(contactDetails) {
  if (!contactDetails || typeof contactDetails !== "object") return [];

  const contacts = [];

  if (contactDetails.email) {
    contacts.push({ contact_type: "email", contact_value: String(contactDetails.email) });
  }

  const parsed = Array.isArray(contactDetails.parsedPhoneNos) ? contactDetails.parsedPhoneNos : [];
  const phoneValues = [];
  let mobileForWhatsapp = null;

  for (const p of parsed) {
    const raw = (p?.number || "").trim();
    const digits = sanitizePhoneNumber(raw);
    if (digits.length < 8) continue;
    const display = normalizePhoneForDisplay(digits);
    if (!display) continue;
    phoneValues.push(display);
    if ((p?.type || "").toString().toUpperCase() === "M") mobileForWhatsapp = display;
  }

  if (!phoneValues.length) {
    const phoneNoRaw = typeof contactDetails.phoneNo === "string" ? contactDetails.phoneNo : "";
    const matches = phoneNoRaw.match(/\d{8,}/g) || [];
    for (const m of matches) {
      const d = normalizePhoneForDisplay(sanitizePhoneNumber(m));
      if (d && !phoneValues.includes(d)) phoneValues.push(d);
    }
  }

  const seen = new Set();
  for (const num of phoneValues) {
    if (seen.has(num)) continue;
    seen.add(num);
    contacts.push({ contact_type: "phone", contact_value: num });
  }

  const whatsappNum = mobileForWhatsapp || phoneValues[0];
  if (whatsappNum) {
    contacts.push({ contact_type: "whatsapp", contact_value: whatsappNum });
  }

  return contacts;
}

function extractOnlineProfileLinksContacts(profile) {
  const links = Array.isArray(profile?.onlineProfileLinks) ? profile.onlineProfileLinks : [];
  if (!links.length) return [];

  const out = [];
  const seenTypes = new Set();

  for (const item of links) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!url) continue;

    const profileName = typeof item?.profile === "string" ? item.profile.trim().toLowerCase() : "";
    let contact_type = "";

    if (profileName.includes("linkedin")) contact_type = "linkedin_url";
    else if (profileName.includes("github")) contact_type = "github_url";
    else if (profileName.includes("instagram")) contact_type = "instagram";
    else if (profileName.includes("facebook")) contact_type = "facebook";
    else continue; // ignore unknown profile types

    if (seenTypes.has(contact_type)) continue;
    seenTypes.add(contact_type);
    out.push({ contact_type, contact_value: url });
  }

  return out;
}

function mapProfileResponseToCandidatesPayload(profile, contactDetails) {
  const fullName = profile?.name || "";
  const preferredLocations = splitCommaValues(profile?.prefLocation);
  const keywords = splitCommaValues(profile?.keywords);

  const contactsFromContactApi = extractContactDetailsContacts(contactDetails);
  const contacts = contactsFromContactApi.length ? contactsFromContactApi : [];
  if (!contacts.length && profile?.email) {
    contacts.push({ contact_type: "email", contact_value: profile.email });
  }

  // Add social/profile URLs from JS profile payload (if present).
  const onlineContacts = extractOnlineProfileLinksContacts(profile);
  for (const c of onlineContacts) {
    const exists = contacts.some(
      (x) => x?.contact_type === c.contact_type && String(x?.contact_value || "") === String(c.contact_value || "")
    );
    if (!exists) contacts.push(c);
  }

  // Map a single project to payload shape (reused for nested and top-level).
  function mapOneProject(p) {
    const start = millisToIsoDate(p?.startYearMillis) || p?.startDate || "";
    const end = millisToIsoDate(p?.endYearMillis) || p?.endDate || "";
    const description = p?.details || "";
    const technologies = [];
    if (typeof p?.skills === "string" && p.skills.trim()) {
      p.skills.split(",").forEach((seg) => {
        const t = seg.trim();
        if (t) technologies.push(t);
      });
    }
    return {
      title: p?.project || "",
      description,
      role: p?.employmentNature || "",
      client: p?.client || "",
      site: p?.site || "",
      start_date: start,
      end_date: end,
      technologies_used: technologies,
      url: null,
    };
  }

  const allProjects = Array.isArray(profile?.projects) ? profile.projects : [];
  const workExperiences = Array.isArray(profile?.workExperiences) ? profile.workExperiences : [];
  const experienceIds = new Set(workExperiences.map((we) => we?.experienceId).filter(Boolean));

  const mappedWorkExperiences = workExperiences.map((we) => {
    const isCurrent =
      (we?.empTypeLable || "").toString().toLowerCase().includes("current") ||
      (we?.endDate || "").toString().toLowerCase().includes("till");
    // NJ: projects linked to this experience via eduExpId === experienceId
    const linkedProjects = allProjects.filter(
      (p) => p?.eduExpId != null && p?.eduExpId === we?.experienceId
    );
    return {
      company_name: we?.organization || "",
      company_description: "",
      company_website: "",
      location: "",
      job_title: we?.designation || "",
      start_date: millisToIsoDate(we?.startYearMillis) || we?.startDate || "",
      end_date: isCurrent ? null : (millisToIsoDate(we?.endYearMillis) || we?.endDate || ""),
      is_current: isCurrent,
      work_summary: we?.profile || "",
      projects: linkedProjects.map(mapOneProject),
    };
  });

  // Top-level projects: only those not linked to any work experience (eduExpId 0, null, or unknown)
  const unlinkedProjects = allProjects.filter((p) => {
    const eid = p?.eduExpId;
    return eid == null || eid === 0 || !experienceIds.has(eid);
  });
  const mappedProjects = unlinkedProjects.map(mapOneProject);

  const educations = Array.isArray(profile?.educations) ? profile.educations : [];
  const mappedEducations = educations.map((ed) => {
    const degree = ed?.course?.label || "";
    const spec = ed?.spec?.label || "";
    const year = ed?.yearOfCompletion || "";
    const eduTypeId = ed?.educationTypeId;
    const fieldOfStudy = eduTypeId === 2 ? "PG" : "UG";
    const inst = ed?.institute?.label || ed?.entityInstitute?.label || "";
    const desc = [degree, spec, year].filter(Boolean).join(",") || "";
    return {
      institution_name: inst,
      degree,
      field_of_study: fieldOfStudy,
      specialization: spec,
      start_date: "",
      completion_date: year,
      grade: "",
      location: "",
      description: desc,
    };
  });

  const languages = Array.isArray(profile?.languages) ? profile.languages : [];
  const mappedLanguages = languages.map((l) => {
    const ability = (l?.ability || "").toString().toLowerCase();
    return {
      language: l?.lang || "",
      proficiency: l?.proficiency?.label || "",
      can_read: ability.includes("read"),
      can_write: ability.includes("write"),
      can_speak: ability.includes("speak"),
    };
  });

  const certifications = Array.isArray(profile?.certifications)
    ? profile.certifications
    : [];
  const mappedCertifications = certifications.map((c) => {
    const rawExpiry = c?.expiryDate || "";
    const expiry =
      rawExpiry && rawExpiry !== "00-0000" ? rawExpiry : null;

    return {
      name: c?.course || "",
      issuing_organization: c?.certificationBody || c?.vendor || "",
      issue_date: c?.issueDate || null,
      expiry_date: expiry,
      credential_id: c?.completionId || "",
      url: c?.certificateUrl || "",
    };
  });

  // Parse "4y", "3.5y" etc. → integer years (0 if not parseable).
  function parseYearsFromLabel(label) {
    if (!label) return undefined;
    const n = parseFloat(String(label).replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }

  const skillsList = [];

  // 1. Key Skills – from comma-separated `keywords` field.
  keywords.forEach((k) => {
    const name = k.trim();
    if (name) skillsList.push({ skill_name: name, proficiency_level: "", skill_type: "Key Skills" });
  });

  // 2. IT Skills – from structured `skills` array (includes years_of_experience).
  (profile?.skills || []).forEach((s) => {
    const label = s?.skill?.label || "";
    if (!label) return;
    const yearsOfExp = parseYearsFromLabel(s?.experienceTimeLable);
    const entry = { skill_name: label, proficiency_level: "", skill_type: "IT Skills" };
    if (yearsOfExp !== undefined) entry.years_of_experience = yearsOfExp;
    skillsList.push(entry);
  });

  // 3. May Also Know – from comma-separated `displayKeywords` field.
  const displayKw = splitCommaValues(profile?.displayKeywords || "");
  displayKw.forEach((k) => {
    const name = k.trim();
    if (name) skillsList.push({ skill_name: name, proficiency_level: "", skill_type: "May Also Know" });
  });

  const lastActiveDate = profile?.viewDate
    ? toIsoDateString(profile.viewDate)
    : profile?.activeDate
      ? String(profile.activeDate).slice(0, 10)
      : "";

  return {
    title: "",
    full_name: fullName,
    avatar: "https://static.naukimg.com/s/7/112/i/defaultAvatar.a0a6df38.svg",
    source: "NJ",
    headline: buildHeadline(profile) || profile?.jobTitle || "",
    designation: (workExperiences[0]?.designation) || profile?.role || "",
    date_of_birth: toIsoDateString(profile?.birthDate),
    place_of_birth: "",
    gender: profile?.gender || "",
    nationality: [],
    religion: "",
    mother_tongue: "",
    marital_status: profile?.maritalStatus || "",
    category: profile?.caste || "",
    notice_period: abbreviateNoticePeriod(profile?.noticePeriod) || "",
    physically_challenged: profile?.physicallyChallenged ? String(profile.physicallyChallenged).toLowerCase() : "",
    desired_job_type: {
      job_type: profile?.jobType || "",
      employment_status: profile?.empStatus || "",
    },
    work_authority: profile?.workStatusOther ? [profile.workStatusOther] : [],
    total_experience_years: profile?.totalExperience || profile?.rawTotalExperience || "",
    modified_at: profile?.modifiedDate || "",
    last_active: lastActiveDate,
    current_ctc: formatCtcDisplay(profile),
    expected_ctc: (profile?.expectedCtcValue && parseFloat(profile.expectedCtcValue) > 0)
      ? formatCtcDisplay({ ...profile, ctcValue: profile.expectedCtcValue, rawCtc: profile.rawExpectedCtc, ctcType: profile.expectedCtcType })
      : "",
    linkedin_url: null,
    contacts,
    addresses: [
      {
        address_type: "current",
        street: profile?.addressWithPin || "",
        city: profile?.city || profile?.homeTown || "",
        state: "",
        postal_code: profile?.pin || "",
        country: "",
      },
    ],
    documents: [],
    professional_summary: {
      summary: profile?.jobTitle || "",
      p_work_summary: profile?.summary || "",
      role: profile?.role || "",
      department: profile?.farea || "",
      industry: profile?.industryType || "",
      total_experience_years: profile?.totalExperience || "",
    },
    job_preference: {
      desired_job_type: profile?.jobType || "",
      preferred_locations: preferredLocations,
      willing_to_relocate: false,
      travel_willingness: null,
      notice_period: abbreviateNoticePeriod(profile?.noticePeriod) || "",
      reason_for_change: null,
      earliest_joining_date: null,
      shift_type: null,
      current_location: profile?.city || "",
    },
    job_board_unique_ids: {
      shine_id: "",
      naukri_id: profile?.userId ? String(profile.userId) : "",
      linkedin_id: "",
    },
    work_experiences: mappedWorkExperiences,
    educations: mappedEducations,
    skills: skillsList,
    languages: mappedLanguages,
    projects: mappedProjects,
    certifications: mappedCertifications,
    trainings: [],
    achievements: [],
    publications: [],
    leadership_volunteering: [],
    affiliations: [],
    references: [],
  };
}

async function maybeSendCombinedCandidateToCandidatesApi(userId) {
  try {
    if (!userId) return;
    await ensureAuthTokenLoaded();

    const profileData = profileByUserId.get(userId);
    const contactDetails = contactByUserId.get(userId);

    if (!profileData || !contactDetails) {
      // console.log("⏳ Waiting for both APIs before /candidates:", { userId, hasProfile: !!profileData, hasContactDetails: !!contactDetails });
      return;
    }

    const signature = [
      userId,
      profileData?.uniqueId || "",
      profileData?.viewDateMillis || profileData?.viewDate || "",
      contactDetails?.email || "",
      contactDetails?.phoneNo || "",
    ].join("|");

    const lastSig = lastSentCandidatesSignatureByUserId.get(userId);
    if (lastSig === signature) {
      // console.log("⏭️  Skipping duplicate /candidates send (same signature):", userId);
      return;
    }
    lastSentCandidatesSignatureByUserId.set(userId, signature);

    const payload = mapProfileResponseToCandidatesPayload(profileData, contactDetails);

    const res = await fetch(CANDIDATES_API_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: getBearerAuthHeaderValue(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();

    // Try to capture backend candidate UUID for resume upload API.
    let candidateId = null;
    try {
      const parsed = JSON.parse(resultText);
      candidateId =
        // Current backend shape:
        // { status, message, data: { success, data: { profile: { id } } } }
        parsed?.data?.data?.profile?.id ||
        parsed?.data?.profile?.id ||
        parsed?.data?.id ||
        parsed?.candidate?.id ||
        parsed?.id ||
        null;
    } catch (e) {
      // response might not be JSON; ignore
    }

    if (!candidateId) {
      candidateId = tryExtractUuidFromCandidatesResponseText(resultText);
    }

    if (candidateId) {
      backendCandidateIdByUserId.set(String(userId), String(candidateId));
      console.log("✅ Captured backend candidate_id for resume upload:", String(candidateId));

      // If resume was captured earlier, upload it now.
      const pending = pendingResumeByUserId.get(String(userId));
      if (pending?.cvBuffer) {
        pendingResumeByUserId.delete(String(userId));
        await uploadResume(
          {
          candidate_id: String(candidateId),
          cvBuffer: pending.cvBuffer,
          cv_updated_at: pending.cv_updated_at || null,
          },
          { userId }
        );
      }

      // Preview-page ✓ badge. Catch sendMessage rejection (tab may have no content script).
      const tabId = previewTabIdByUserId.get(String(userId)) || latestPreviewTabId;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, {
          type: "NJB_PREVIEW_BADGE",
          candidateId: String(candidateId),
        }).catch(() => {});
      }

      // Refresh verified-ids (for list badges) using the last Interceptor payload ONLY.
      // This avoids the content-script DOM parsing call that caused a second API hit.
      try {
        if (lastNjbVerifiedIdsPayload?.body) {
          await postVerifiedIdsAndBroadcast(lastNjbVerifiedIdsPayload.body, true /* force */);
        }
      } catch (e) {
        console.warn("[NJB] Verified-ids refresh after save failed:", e);
      }

      // After a profile is saved (candidate exists in DB), refresh list-page badges
      // on all Naukri search tabs, same behavior as Working_extension.
      try {
        const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
        const naukriTabs = (tabs || []).filter((t) => {
          const u = (t?.url || "").toLowerCase();
          return u.includes("naukri.com") && u.includes("/v3/search");
        });
        for (const tab of naukriTabs) {
          if (!tab?.id) continue;
          chrome.tabs.sendMessage(tab.id, { type: "NJB_REFRESH_BADGES" }).catch(() => {});
        }
      } catch {
        // ignore
      }
    }

    // console.log("✅ Sent merged profile+contacts payload to /candidates:", { status: res.status, body: resultText });
  } catch (err) {
    console.error("❌ Failed to send merged payload to /candidates:", err);
  }
}

// --------------------------------------------------------------------------------------
// NJB verified-ids handler (used by /v3/search badge flow)
// --------------------------------------------------------------------------------------

async function handleCheckNjbProfiles(message, sendResponse) {
  try {
    await ensureAuthTokenLoaded();

    const frontPage = Array.isArray(message?.jobBoardFrontPageDetails)
      ? message.jobBoardFrontPageDetails
      : [];

    const response = await fetch(VERIFIED_IDS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: getBearerAuthHeaderValue(),
      },
      body: JSON.stringify({
        jobBoard: message?.jobBoard || "njb",
        jobBoardFrontPageDetails: frontPage,
      }),
    });

    const data = await response.json().catch(() => null);

    const matched = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item?.match === true) {
          matched.push({
            index: item.index,
            name: item.name || "",
            candidateId: item.candidate_id || item.candidateId || "",
            matchedBy: item.matched_by,
          });
        }
      }
    }

    sendResponse({ matched });
    return true;
  } catch (err) {
    console.error("[CHECK_NJB_PROFILES] Error:", err);
    sendResponse({ matched: [], error: err?.message || String(err) });
    return true;
  }
}

async function sendCandidateProfileToCandidatesApi(profileData) {
  try {
    // Deprecated: keep for backward compatibility, but prefer merged flow.
    await ensureAuthTokenLoaded();
    const payload = mapProfileResponseToCandidatesPayload(profileData, null);

    const res = await fetch(CANDIDATES_API_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: getBearerAuthHeaderValue(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();
    console.log("✅ Sent profile payload to /candidates:", {
      status: res.status,
      body: resultText,
      naukri_unique_id: payload?.job_board_unique_ids?.naukri_unique_id,
      naukri_id: payload?.job_board_unique_ids?.naukri_id,
    });
  } catch (err) {
    console.error("❌ Failed to send profile payload to /candidates:", err);
  }
}

function extractFilteredCandidate(tuple) {
  return {
    jsUserName: tuple?.jsUserName || "",
    keySkills: tuple?.keySkills || "",
    focusedSkills: tuple?.focusedSkills || "",
    uniqueId: tuple?.uniqueId || "",
    education: tuple?.education || { ug: null, pg: null, ppg: null },
    employment: tuple?.employment || { current: null, previous: null },
    ctcInfo: tuple?.ctcInfo || null,
    experience: tuple?.experience || null,
    currentLocation: tuple?.currentLocation || "",
    preferredLocations: tuple?.preferredLocations || "",
    jsUserId: tuple?.jsUserId || null,
  };
}

function buildFrontPageDetail(candidate) {
  const companies = [];
  const currentEmployment = candidate?.employment?.current;
  const previousEmployment = candidate?.employment?.previous;

  if (currentEmployment && (currentEmployment.organization || currentEmployment.designation)) {
    companies.push({
      company_name: currentEmployment.organization || "",
      job_title: currentEmployment.designation || "",
      is_current: true,
    });
  }

  if (previousEmployment && (previousEmployment.organization || previousEmployment.designation)) {
    companies.push({
      company_name: previousEmployment.organization || "",
      job_title: previousEmployment.designation || "",
      is_current: false,
    });
  }

  const ugEducation = candidate?.education?.ug || {};

  return {
    name: candidate.jsUserName || "",
    email: "",
    phone: "",
    naukri_unique_id: candidate.uniqueId || "",
    education: {
      degree: ugEducation.course || "",
      specialization: ugEducation.specialization || "",
      institute_name: ugEducation.institute || "",
    },
    companies,
  };
}

async function sendListingCandidatesData(data) {
  try {
    await ensureAuthTokenLoaded();
    const tuples = Array.isArray(data?.tuples) ? data.tuples : [];
    if (!tuples.length) {
      console.log("⏭️  Listing payload has no tuples");
      return;
    }

    const filteredCandidates = tuples
      .map(extractFilteredCandidate)
      .filter((candidate) => candidate.uniqueId && candidate.jsUserId);

    if (!filteredCandidates.length) {
      console.log("⏭️  No valid candidate uniqueId/jsUserId found in tuples");
      return;
    }

    const signature = `${data?.sid || "no-sid"}:${filteredCandidates
      .map((candidate) => String(candidate.jsUserId))
      .join(",")}`;
    if (signature === lastListingSignature) {
      console.log("⏭️  Skipping duplicate listing payload");
      return;
    }
    lastListingSignature = signature;

    const payload = {
      jobBoard: "njb",
      ids: filteredCandidates.map((candidate) => String(candidate.jsUserId)),
      jobBoardFrontPageDetails: filteredCandidates.map(buildFrontPageDetail),
    };

    // Cache last Interceptor payload for "refresh after save" use.
    lastNjbVerifiedIdsPayload = { signature, body: payload };

    await postVerifiedIdsAndBroadcast(payload, false /* force */);
  } catch (err) {
    console.error("❌ Failed to send listing candidates data:", err);
  }
}

async function postVerifiedIdsAndBroadcast(payload, force) {
  await ensureAuthTokenLoaded();

  // De-dupe unless forced (this prevents double calls on the same intercepted payload).
  const signature = (payload?.ids || []).join(",") + "|" + (payload?.jobBoard || "");
  if (!force && signature && signature === lastNjbVerifiedIdsPayload?.lastSentSignature) {
    return;
  }
  if (lastNjbVerifiedIdsPayload) {
    lastNjbVerifiedIdsPayload.lastSentSignature = signature;
  }

    const res = await fetch(VERIFIED_IDS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
      Authorization: getBearerAuthHeaderValue(),
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();
    console.log("✅ Sent listing candidates to verified-ids API:", {
      status: res.status,
      body: resultText,
    count: Array.isArray(payload?.ids) ? payload.ids.length : 0,
  });

  // The verified-ids API returns an array with { match, index, candidate_id } items.
  // Forward only matched rows to content scripts so they can paint badges on /v3/search.
  try {
    const parsed = JSON.parse(resultText);
    const matched = [];
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.match === true) {
          matched.push({
            index: item.index,
            name: item.name || "",
            candidateId: item.candidate_id || item.candidateId || "",
            matchedBy: item.matched_by,
          });
        }
      }
    }

    const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
    const naukriTabs = (tabs || []).filter((t) => {
      const u = (t?.url || "").toLowerCase();
      return u.includes("naukri.com");
    });

    for (const tab of naukriTabs) {
      if (!tab?.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: "NJB_VERIFIED_IDS_MATCHES", matched }).catch(() => {});
    }
  } catch {
    // ignore parse/forward errors
  }
}

// --------------------------------------------------------------------------------------
// NJ (Naukri) session export/import + logout cookie cleanup
// Ported from Working_extension, restricted to Naukri only.
// --------------------------------------------------------------------------------------

function isNaukriUrl(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    return host === "naukri.com" || host.endsWith(".naukri.com");
  } catch {
    return false;
  }
}

function normalizeNaukriUrl(inputUrl) {
  // Prefer resdex.naukri.com for session import unless it's hiring.naukri.com.
  let finalUrl = inputUrl || "https://resdex.naukri.com";
  try {
    const url = new URL(finalUrl);
    const host = url.hostname.toLowerCase();
    if (host.includes("hiring.naukri.com")) return url.toString();
    if (host.includes("naukri.com")) {
      url.hostname = "resdex.naukri.com";
      return url.toString();
    }
  } catch {
    // ignore
  }
  return "https://resdex.naukri.com";
}

function validateSessionData(sessionData) {
  if (!sessionData || !sessionData.data) throw new Error("Invalid session data structure");

  let urlHostname = null;
  try {
    if (sessionData.url) urlHostname = new URL(sessionData.url).hostname || null;
  } catch {
    urlHostname = null;
  }

  const preparedCookies = (sessionData.data.cookies || []).map((cookie) => {
    const prepared = { ...cookie };
    if (!prepared.domain && urlHostname) prepared.domain = urlHostname;
    return prepared;
  });

  const cleanedCookies = preparedCookies
    .filter((cookie) => cookie && cookie.name && cookie.value !== undefined && cookie.domain)
    .map((cookie) => {
      const cleanedCookie = { ...cookie };
      if (!cleanedCookie.path) cleanedCookie.path = "/";
      if (!cleanedCookie.sameSite) cleanedCookie.sameSite = "unspecified";
      if (cleanedCookie.secure === undefined) cleanedCookie.secure = false;
      if (cleanedCookie.httpOnly === undefined) cleanedCookie.httpOnly = false;

      if (
        cleanedCookie.domain &&
        !cleanedCookie.domain.startsWith(".") &&
        cleanedCookie.domain.includes(".")
      ) {
        cleanedCookie.domain = "." + cleanedCookie.domain;
      }
      return cleanedCookie;
    });

  const cleanedLocalStorage = sessionData.data.localStorage || {};
  const cleanedSessionStorage = sessionData.data.sessionStorage || {};

  Object.keys(cleanedLocalStorage).forEach((key) => {
    if (cleanedLocalStorage[key] == null) delete cleanedLocalStorage[key];
  });
  Object.keys(cleanedSessionStorage).forEach((key) => {
    if (cleanedSessionStorage[key] == null) delete cleanedSessionStorage[key];
  });

  if (
    cleanedCookies.length === 0 &&
    Object.keys(cleanedLocalStorage).length === 0 &&
    Object.keys(cleanedSessionStorage).length === 0
  ) {
    throw new Error("No valid session data found (cookies, localStorage, or sessionStorage)");
  }

  return {
    ...sessionData,
    data: {
      ...sessionData.data,
      cookies: cleanedCookies,
      localStorage: cleanedLocalStorage,
      sessionStorage: cleanedSessionStorage,
    },
  };
}

async function getPlatformInfo() {
  return new Promise((resolve) => {
    chrome.runtime.getPlatformInfo((platformInfo) => {
      resolve({
        os: platformInfo.os,
        arch: platformInfo.arch,
      });
    });
  });
}

async function getAllCookies(urlObject) {
  return chrome.cookies.getAll({ url: urlObject.href });
}

async function getLocalStorageData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        function: () => {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
          }
          return data;
        },
      },
      (results) => resolve(results?.[0]?.result || {})
    );
  });
}

async function getSessionStorageData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId: tab.id },
        function: () => {
          const data = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            data[key] = sessionStorage.getItem(key);
          }
          return data;
        },
      },
      (results) => resolve(results?.[0]?.result || {})
    );
  });
}

async function setLocalStorage(tab, data) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: (localStorageData) => {
      for (const key in localStorageData) {
        if (localStorageData[key] != null) localStorage.setItem(key, localStorageData[key]);
      }
    },
    args: [data],
  });
}

async function setSessionStorage(tab, data) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    function: (sessionStorageData) => {
      for (const key in sessionStorageData) {
        if (sessionStorageData[key] != null) sessionStorage.setItem(key, sessionStorageData[key]);
      }
    },
    args: [data],
  });
}

async function storeImportedSessionInExtension(additionalInfo) {
  const result = await new Promise((resolve) => chrome.storage.local.get("importSessions", resolve));
  const importSessions = result?.importSessions || [];

  const existingIndex = importSessions.findIndex((session) => session.domain === additionalInfo.domain);
  if (existingIndex !== -1) importSessions[existingIndex] = additionalInfo;
  else importSessions.push(additionalInfo);

  await chrome.storage.local.set({ importSessions });
}

async function clearBrowserCacheBeforeImport(url) {
  // Naukri-only targeted cleanup.
  let finalUrl = normalizeNaukriUrl(url);
  const origin = new URL(finalUrl).origin;

  await new Promise((resolve) => {
    chrome.browsingData.remove(
      { origins: [origin] },
      {
        cache: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        pluginData: true,
        serviceWorkers: true,
      },
      resolve
    );
  });

  const domainPatterns = [".naukri.com", "resdex.naukri.com", "www.naukri.com", "hiring.naukri.com"];
  for (const domain of domainPatterns) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const cookie of cookies) {
        try {
          const urlToRemove = `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
          await chrome.cookies.remove({ url: urlToRemove, name: cookie.name });
        } catch {
          // ignore individual cookie failures
        }
      }
    } catch {
      // ignore domain failures
    }
  }

  // Clear a small set of known session keys in extension storage.
  try {
    await chrome.storage.local.remove(["importSessions", "exportSessions"]);
  } catch {
    // ignore
  }
}

async function handleImportSession(sessionData, sendResponse) {
  try {
    if (!sessionData?.url || !isNaukriUrl(sessionData.url)) {
      sendResponse({ success: false, error: "Only Naukri sessions are supported in this extension." });
      return;
    }

    const finalUrl = normalizeNaukriUrl(sessionData.url);
    await clearBrowserCacheBeforeImport(finalUrl);

    const cleanedSessionData = validateSessionData(sessionData);
    const data = cleanedSessionData.data;
    const localStorageData = data.localStorage || {};
    const sessionStorageData = data.sessionStorage || {};
    const cookies = data.cookies || [];

    const platformInfo = await getPlatformInfo();

    // Create a temp tab to ensure the domain is "accepted" before setting cookies.
    const tempTab = await chrome.tabs.create({ url: finalUrl, active: false });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let successCount = 0;
    let failureCount = 0;
    for (const cookie of cookies) {
      try {
        const domain = cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`;
        const cookieDetails = {
          url: `https://${domain.replace(/^\./, "")}${cookie.path || "/"}`,
          name: cookie.name,
          value: cookie.value,
          domain,
          path: cookie.path || "/",
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          expirationDate: cookie.expirationDate || Math.floor(Date.now() / 1000) + 31536000,
        };
        if (["Strict", "Lax", "None"].includes(cookie.sameSite)) cookieDetails.sameSite = cookie.sameSite;
        await chrome.cookies.set(cookieDetails);
        successCount++;
  } catch (err) {
        failureCount++;
        console.warn("Failed to set cookie", cookie?.name, err);
      }
    }

    await chrome.tabs.remove(tempTab.id);

    const tab = await chrome.tabs.create({ url: finalUrl, active: false });

    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    await setLocalStorage(tab, localStorageData);
    await setSessionStorage(tab, sessionStorageData);

    await chrome.tabs.reload(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await chrome.tabs.update(tab.id, { active: true });

    await storeImportedSessionInExtension({
      imported_at: new Date().toISOString(),
      url: finalUrl,
      domain: new URL(finalUrl).hostname,
      total_cookies: cookies.length,
      successful_cookies: successCount,
      failed_cookies: failureCount,
      platform: platformInfo.os,
      id: sessionData.id || "unknown",
    });

    sendResponse({ success: true, cookiesSet: successCount, cookiesFailed: failureCount });
  } catch (error) {
    console.error("Import session error:", error);
    sendResponse({ success: false, error: "Failed to import session: " + error.message });
  }
}

async function handleExportSession(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      sendResponse({ status: 0, message: "No active tab or URL found." });
      return;
    }

    if (!isNaukriUrl(tab.url)) {
      sendResponse({ status: 0, message: "Only Naukri tabs are supported for sharing session." });
      return;
    }

    const url = new URL(tab.url);
    const cookies = await getAllCookies(url);
    const localStorage = await getLocalStorageData();
    const sessionStorage = await getSessionStorageData();

    sendResponse({
      status: 1,
      data: {
        domain: url.hostname,
        url: tab.url,
        cookies,
        timestamp: new Date().toISOString(),
        localStorage: localStorage || {},
        sessionStorage: sessionStorage || {},
      },
    });
  } catch (error) {
    console.error("Share session error:", error);
    sendResponse({ status: 0, message: "Failed to share session: " + error.message });
  }
}

async function handleLogoutAndClearData(sendResponse) {
  try {
    const domainsToClean = [
      { domain: ".naukri.com", url: "https://resdex.naukri.com" },
      { domain: "resdex.naukri.com", url: "https://resdex.naukri.com" },
      { domain: "www.naukri.com", url: "https://www.naukri.com" },
      { domain: "hiring.naukri.com", url: "https://hiring.naukri.com" },
    ];

    let totalCookiesRemoved = 0;
    for (const { domain } of domainsToClean) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          try {
            const urlToRemove = `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
            await chrome.cookies.remove({ url: urlToRemove, name: cookie.name });
            totalCookiesRemoved++;
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    try {
      await chrome.storage.local.remove(["importSessions", "exportSessions", "authToken"]);
    } catch {
      // ignore
    }

    sendResponse({ success: true, cookiesRemoved: totalCookiesRemoved });
  } catch (err) {
    console.error("Logout cleanup error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

async function getDomain(sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) throw new Error("No active tab or URL found.");
    const url = new URL(tab.url);
    sendResponse({ success: true, domain: url.hostname });
  } catch (error) {
    sendResponse({ success: false, error: "Failed to get domain: " + error.message });
  }
}


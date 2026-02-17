import { getStoredAuth } from "./core/auth.js";
import { ETICA_EXT_URL } from "./config/constants.js";
import { handleSjbProfile, handleSjbUpdateResume, handleCheckSjbIds } from "./background/sjb/handlers.js";
import { handleCheckCanScrape } from "./background/core/rateLimit.js";
import {
  handleImportSession as handleImportSessionCross,
  handleExportSession as handleExportSessionCross,
  handleLogoutAndClearData as handleLogoutAndClearDataCross,
  getDomain as getDomainCross,
} from "./background/core/sessionImport.js";

const VERIFIED_IDS_API_URL = "https://masterapi.eticaatest.co.in/candidates/verified-ids";

const CANDIDATES_API_URL = "https://masterapi.eticaatest.co.in/candidates";

const UPLOAD_RESUME_API_URL = "https://masterapi.eticaatest.co.in/candidates/upload-resume";

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

function handleApiInterceptorMessage(msg, sender) {
  // console.log("🔔 Background received message:", msg?.url);

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
    (msg.url.includes("/jsprofile/download/resume") || msg.url.includes("jsprofile/download/resume"));
  const isListingPage = typeof msg.pathname === "string" && msg.pathname.includes("search");
  const hasTuples = Array.isArray(msg?.data?.tuples);

  if (isListingPage && hasTuples) return sendListingCandidatesData(msg.data);

  if (isResumeApi) {
    const cvBuffer = typeof msg?.data?.cvBuffer === "string" ? msg.data.cvBuffer : "";
    if (!cvBuffer) {
      console.log("⏭️  Resume API detected but cvBuffer missing");
      return;
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
      { userId: userIdKey }
    );
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
  sendCandidateData(msg.data);

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
    // Interceptor pipeline (contentScript -> background).
    if (message?.source === "API_INTERCEPTOR") {
      handleApiInterceptorMessage(message, sender);
      return;
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
          const uninstallUrl = `https://dms.eticaa.com/extension/uninstall?token=${encodeURIComponent(token)}`;
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

async function maybeMapCustomerToCandidateAfterResumeUpload(userId, candidateId) {
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
      job_board: "NJ",
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
      await maybeMapCustomerToCandidateAfterResumeUpload(opts?.userId, data?.candidate_id);
    }
  } catch (err) {
    console.error("❌ Failed to upload resume:", err);
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

async function sendCandidateData(data) {
  try {
    const res = await fetch(
      "http://localhost:5001/api/candidate-intercept-data",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(data),
      }
    );

    const result = await res.json();
    console.log("✅ Sent to backend (background):", result);
  } catch (err) {
    console.error("❌ Failed to send candidate data (background):", err);
  }
}

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

  const workExperiences = Array.isArray(profile?.workExperiences) ? profile.workExperiences : [];
  const mappedWorkExperiences = workExperiences.map((we) => {
    const isCurrent =
      (we?.empTypeLable || "").toString().toLowerCase().includes("current") ||
      (we?.endDate || "").toString().toLowerCase().includes("till");
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
    };
  });

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

  const projects = Array.isArray(profile?.projects) ? profile.projects : [];
  const mappedProjects = projects.map((p) => {
    const start = millisToIsoDate(p?.startYearMillis) || "";
    const end = millisToIsoDate(p?.endYearMillis) || "";
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
      role: description ? `Project description: ${description}` : "",
      client: "",
      start_date: start,
      end_date: end,
      technologies_used: technologies,
      url: null,
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

  const skillsList = [];
  keywords.forEach((k) => skillsList.push({ skill_name: k.trim(), category: null }));
  (profile?.skills || []).forEach((s) => {
    const label = s?.skill?.label || "";
    if (label && !skillsList.some((x) => x.skill_name === label)) {
      skillsList.push({ skill_name: label, category: "it_skills" });
    }
  });
  const displayKw = splitCommaValues(profile?.displayKeywords || "");
  displayKw.forEach((k) => {
    const name = k.trim();
    if (name && !skillsList.some((x) => x.skill_name === name)) {
      skillsList.push({ skill_name: name, category: "may_also_know" });
    }
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
    designation: profile?.role || (workExperiences[0]?.designation) || "",
    date_of_birth: toIsoDateString(profile?.birthDate),
    place_of_birth: "",
    gender: profile?.gender || "",
    nationality: [],
    religion: "",
    mother_tongue: "",
    marital_status: profile?.maritalStatus || "",
    category: "General",
    notice_period: abbreviateNoticePeriod(profile?.noticePeriod) || "",
    physically_challenged: "",
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
        street: "",
        city: profile?.city || "",
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
      desired_position: profile?.role || "",
      desired_job_type: profile?.jobType || "",
      preferred_locations: preferredLocations,
      willing_to_relocate: false,
      travel_willingness: null,
      notice_period: abbreviateNoticePeriod(profile?.noticePeriod) || "",
      reason_for_change: null,
      earliest_joining_date: null,
      functional_area: profile?.farea || "",
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

      // Preview-page ✓ badge (same idea as Working_extension addNjbBadge on preview):
      // send candidateId to the preview tab that triggered the intercept.
      try {
        const tabId = previewTabIdByUserId.get(String(userId)) || latestPreviewTabId;
        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            type: "NJB_PREVIEW_BADGE",
            candidateId: String(candidateId),
          });
        }
      } catch {
        // ignore
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
          try {
            chrome.tabs.sendMessage(tab.id, { type: "NJB_REFRESH_BADGES" });
          } catch {
            // ignore
          }
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
      try {
        // Always send; content script will route-guard to /v3/search.
        chrome.tabs.sendMessage(tab.id, { type: "NJB_VERIFIED_IDS_MATCHES", matched });
      } catch {
        // ignore
      }
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


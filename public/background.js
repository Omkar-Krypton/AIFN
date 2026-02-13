const VERIFIED_IDS_API_URL = "http://localhost:2000/candidates/verified-ids";
const VERIFIED_IDS_BEARER_TOKEN =
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImE4YzQ2NjU1LTA2ODMtNDQ3OC1iYzFkLTIyOWVmYmMyOGJkMiIsImVtYWlsIjoic2hydXRpQHBsYWNvbmhyLmNvbSIsInJvbGUiOiJ1c2VyIiwiaXNBY3RpdmUiOnRydWUsImZ1bGxOYW1lIjoiU2hydXRpIiwibW9iaWxlIjoiMTIzNDU2Nzg5MCIsImxvY2F0aW9uIjoiQWhtZWRhYmFkIiwiY3VzdG9tZXJJZCI6IjhkMmY0MGFjLTk5YmEtNDk0Yy1iNWI1LTI4YmRjMzRiNDU2OCIsImlhdCI6MTc3MDcyNTYzMSwiZXhwIjoxOTI4NTEzNjMxfQ.X39paZs28FaRQs3pdohFWAM0jebLMKO8HLCzcm7DvEo";

const CANDIDATES_API_URL = "http://localhost:2000/candidates";
const CANDIDATES_BEARER_TOKEN =
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjlkZDQ2ZWFlLTJiMjItNDA0Yy1iNGE0LTFjMWM3M2I5Y2E0YyIsImVtYWlsIjoiYmh1bWlrYUBwbGFjb25oci5jb20iLCJyb2xlIjoidXNlciIsImlzQWN0aXZlIjp0cnVlLCJmdWxsTmFtZSI6IkJodW1pa2EgS290aGFyaSIsIm1vYmlsZSI6IjEyMzQ1Njc4OTAiLCJsb2NhdGlvbiI6IkFobWVkYWJhZCIsImN1c3RvbWVySWQiOiI4ZDJmNDBhYy05OWJhLTQ5NGMtYjViNS0yOGJkYzM0YjQ1NjgiLCJpYXQiOjE3NzA3MzkzMDYsImV4cCI6MTkyODUyNzMwNn0.9pGc5sw6gjMy4C8gWJZusRg23bJSBIowapnZtnZVb3Q";

const UPLOAD_RESUME_API_URL = "http://localhost:2000/candidates/upload-resume";

// Resume uploads must use the backend UUID returned by POST /candidates.
// We buffer resumes until that UUID is known.

let lastListingSignature = null;

// Profile page (preview) needs 2 API responses before sending /candidates:
// 1) recruiter-js-profile-services (profile)
// 2) contactdetails (contact info)
const profileByUserId = new Map(); // userId -> profile response
const contactByUserId = new Map(); // userId -> contactdetails response
const lastSentCandidatesSignatureByUserId = new Map(); // userId -> signature

// Used for resume upload correlation (resume API doesn't include IDs reliably).
let latestPreviewUserId = null;
let latestPreviewUniqueId = null;

// backendCandidateId (UUID) keyed by naukri userId (string)
const backendCandidateIdByUserId = new Map();

// Buffer resume until we know backend candidate UUID.
const pendingResumeByUserId = new Map(); // userId -> { cvBuffer, cv_updated_at }

chrome.runtime.onMessage.addListener((msg) => {
  // console.log("🔔 Background received message:", msg?.url);

  if (msg?.source !== "API_INTERCEPTOR") {
    // console.log("⏭️  Skipping: not from API_INTERCEPTOR");
    return;
  }

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

  if (isListingPage && hasTuples) {
    return sendListingCandidatesData(msg.data);
  }

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

    return uploadResume({
      candidate_id: backendCandidateId,
      cvBuffer,
      // Backend expects YYYY-MM-DD (string) or null
      cv_updated_at,
    });
  }

  if (isContactDetailsOnPreview) {
    const userId = msg?.data?.userId;
    if (!userId) {
      // console.log("⏭️  Contactdetails missing userId");
      return;
    }

    latestPreviewUserId = String(userId);
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
    profileByUserId.set(String(profileUserId), msg.data);
    return maybeSendCombinedCandidateToCandidatesApi(String(profileUserId));
  }

  console.log("⏭️  Profile response missing userId, cannot merge with contacts");
});

function tryExtractUuidFromCandidatesResponseText(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function uploadResume(data) {
  try {
    const res = await fetch(UPLOAD_RESUME_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        Authorization: CANDIDATES_BEARER_TOKEN,
      },
      body: JSON.stringify(data),
    });

    const resultText = await res.text();
    console.log("✅ Uploaded resume to backend:", { status: res.status, candidate_id: data?.candidate_id });
    // console.log("upload-resume response body:", resultText);
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

function mapProfileResponseToCandidatesPayload(profile, contactDetails) {
  const fullName = profile?.name || "";
  const preferredLocations = splitCommaValues(profile?.prefLocation);
  const keywords = splitCommaValues(profile?.keywords);

  const contactsFromContactApi = extractContactDetailsContacts(contactDetails);
  const contacts = contactsFromContactApi.length ? contactsFromContactApi : [];
  if (!contacts.length && profile?.email) {
    contacts.push({ contact_type: "email", contact_value: profile.email });
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
        Authorization: CANDIDATES_BEARER_TOKEN,
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
        await uploadResume({
          candidate_id: String(candidateId),
          cvBuffer: pending.cvBuffer,
          cv_updated_at: pending.cv_updated_at || null,
        });
      }
    }

    // console.log("✅ Sent merged profile+contacts payload to /candidates:", { status: res.status, body: resultText });
  } catch (err) {
    console.error("❌ Failed to send merged payload to /candidates:", err);
  }
}

async function sendCandidateProfileToCandidatesApi(profileData) {
  try {
    // Deprecated: keep for backward compatibility, but prefer merged flow.
    const payload = mapProfileResponseToCandidatesPayload(profileData, null);

    const res = await fetch(CANDIDATES_API_URL, {
      method: "POST",
      headers: {
        accept: "*/*",
        Authorization: CANDIDATES_BEARER_TOKEN,
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

    const res = await fetch(VERIFIED_IDS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        Authorization: VERIFIED_IDS_BEARER_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();
    console.log("✅ Sent listing candidates to verified-ids API:", {
      status: res.status,
      body: resultText,
      count: payload.ids.length,
    });
  } catch (err) {
    console.error("❌ Failed to send listing candidates data:", err);
  }
}


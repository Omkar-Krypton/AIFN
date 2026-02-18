// Build /candidates payload for Naukri Hiring (source: "NH").

function splitCommaValues(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function sanitizePhoneNumber(value) {
  if (!value || typeof value !== "string") return "";
  return value.replace(/[^\d]/g, "");
}

function normalizePhoneForDisplay(digits) {
  if (!digits) return "";
  if (digits.length > 10 && digits.startsWith("91")) return digits.slice(2);
  return digits;
}

function formatLocalDateString(d) {
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toIsoDateStringFromDateTimeLike(input) {
  if (!input) return "";
  // "2025-12-05 16:31:15" -> "2025-12-05"
  const s = String(input);
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return formatLocalDateString(d);
}

function formatInrFromAbsolute(abs) {
  const n = typeof abs === "number" ? abs : parseFloat(String(abs || "0"));
  if (!Number.isFinite(n) || n <= 0) return "";
  return `₹ ${Math.round(n).toLocaleString("en-IN")}`;
}

function extractNhContacts(contactDetails) {
  const contacts = [];
  const emails = Array.isArray(contactDetails?.email) ? contactDetails.email : [];
  for (const e of emails) {
    const val = typeof e?.value === "string" ? e.value.trim() : "";
    if (val) {
      contacts.push({ contact_type: "email", contact_value: val });
      break; // keep primary only
    }
  }

  const phones = Array.isArray(contactDetails?.phoneNumber) ? contactDetails.phoneNumber : [];
  const seenPhone = new Set();
  let firstPhone = "";
  for (const p of phones) {
    const raw = typeof p?.value === "string" ? p.value.trim() : "";
    const digits = sanitizePhoneNumber(raw);
    const display = normalizePhoneForDisplay(digits);
    if (!display || display.length < 8) continue;
    if (seenPhone.has(display)) continue;
    seenPhone.add(display);
    if (!firstPhone) firstPhone = display;
    contacts.push({ contact_type: "phone", contact_value: display });
  }

  if (firstPhone) {
    contacts.push({ contact_type: "whatsapp", contact_value: firstPhone });
  }

  return contacts;
}

export function mapNhApplicationToCandidatesPayload(applicationDetail, contactDetails) {
  const app = applicationDetail && typeof applicationDetail === "object" ? applicationDetail : {};
  const contacts = extractNhContacts(contactDetails || {});

  const keySkills = splitCommaValues(app?.keySkills || "");
  const mayAlsoKnow = splitCommaValues(app?.mayAlsoKnowSkills || "");

  const skills = [];
  keySkills.forEach((k) => skills.push({ skill_name: k, category: null }));
  mayAlsoKnow.forEach((k) => {
    if (!skills.some((x) => x.skill_name === k)) skills.push({ skill_name: k, category: "may_also_know" });
  });

  const workExp = Array.isArray(app?.workExp) ? app.workExp : [];
  const mappedWork = workExp.map((we) => {
    const isCurrent = String(we?.current || "") === "1" || we?.workingTo == null;
    return {
      company_name: we?.company || "",
      company_description: "",
      company_website: "",
      location: "",
      job_title: we?.designation || "",
      start_date: we?.workingFrom || "",
      end_date: isCurrent ? null : (we?.workingTo || ""),
      is_current: isCurrent,
      work_summary: we?.jobProfile || "",
    };
  });

  const edu = Array.isArray(app?.education) ? app.education : [];
  const mappedEdu = edu.map((ed) => {
    const year = ed?.year ? String(ed.year) : "";
    const degreeType = (ed?.degreeType || "").toString().toLowerCase();
    const field = degreeType.includes("post") ? "PG" : "UG";
    return {
      institution_name: ed?.institute || "",
      degree: ed?.degree || "",
      field_of_study: field,
      specialization: ed?.specialization || "",
      start_date: "",
      completion_date: year,
      grade: "",
      location: "",
      description: [ed?.degree || "", ed?.specialization || "", year].filter(Boolean).join(","),
    };
  });

  const languages = Array.isArray(app?.languages) ? app.languages : [];
  const mappedLang = languages.map((l) => {
    return {
      language: l?.language || "",
      proficiency: l?.proficiency || "",
      can_read: Boolean(l?.canRead),
      can_write: Boolean(l?.canWrite),
      can_speak: Boolean(l?.canSpeak),
    };
  });

  const totalExpYears =
    typeof app?.experience?.years === "number" ? String(app.experience.years) : (app?.experience?.years ? String(app.experience.years) : "");

  return {
    title: "",
    full_name: app?.name || "",
    avatar: app?.profileImageUrl || app?.photo || "https://static.naukimg.com/s/7/112/i/defaultAvatar.a0a6df38.svg",
    source: "NH",
    headline: app?.profileSummary || app?.role || "",
    designation: app?.role || (mappedWork[0]?.job_title || ""),
    date_of_birth: toIsoDateStringFromDateTimeLike(app?.otherDetails?.personal?.dob || ""),
    place_of_birth: "",
    gender: app?.otherDetails?.personal?.gender || "",
    nationality: [],
    religion: "",
    mother_tongue: "",
    marital_status: app?.otherDetails?.personal?.maritalStatus || "",
    category: "General",
    notice_period: app?.noticePeriod || "",
    physically_challenged: "",
    desired_job_type: {
      job_type: app?.otherDetails?.desiredJD?.jobType || "",
      employment_status: app?.otherDetails?.desiredJD?.employerStatus || "",
    },
    work_authority: [],
    total_experience_years: totalExpYears,
    modified_at: toIsoDateStringFromDateTimeLike(app?.addedOn || ""),
    last_active: toIsoDateStringFromDateTimeLike(app?.lastActiveOnResdex || ""),
    current_ctc: formatInrFromAbsolute(app?.ctc?.absolute || 0),
    expected_ctc: formatInrFromAbsolute(app?.expectedCtc?.absolute || 0),
    linkedin_url: null,
    contacts,
    addresses: [
      {
        address_type: "current",
        street: "",
        city: app?.currentCity || "",
        state: "",
        postal_code: "",
        country: "",
      },
    ],
    job_preferences: {
      preferred_locations: splitCommaValues(app?.preferredLocations || ""),
      preferred_industries: [],
      preferred_functions: [],
      preferred_roles: [],
      expected_salary: "",
    },
    social_media_links: [],
    about: {
      summary: app?.profileSummary || "",
      hobbies: "",
      strengths: "",
      weaknesses: "",
    },
    employment_detail: {
      employment_status: app?.isCurrentlyUnemployed ? "unemployed" : "",
      shift_type: null,
      current_location: app?.currentCity || "",
    },
    job_board_unique_ids: {
      shine_id: "",
      naukri_id: app?.jobSeekerUserId ? String(app.jobSeekerUserId) : "",
      linkedin_id: "",
    },
    work_experiences: mappedWork,
    educations: mappedEdu,
    skills,
    languages: mappedLang,
    projects: [],
    certifications: [],
    trainings: [],
    achievements: [],
    publications: [],
    leadership_volunteering: [],
    affiliations: [],
    references: [],
  };
}

export function extractCvUpdatedAtFromNhApplication(applicationDetail) {
  return toIsoDateStringFromDateTimeLike(applicationDetail?.addedOn || "") || formatLocalDateString(new Date());
}


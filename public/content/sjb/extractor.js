/* global chrome, downloadAndConvertCV, transformSjbProfile, sendMessageSafely */

let sjbProfileScraped = false;
let sjbScrapingInProgress = false; // Prevent multiple simultaneous scraping attempts

// Rate limit state (prefixed with sjb_ to avoid conflicts with njb extractor)
let sjb_isRateLimitBlocked = false;
let sjb_rateLimitOverlay = null;
let sjb_rateLimitInfo = null;

// Rate limit check cache to prevent infinite loops
let sjb_lastRateLimitCheck = null;
let sjb_rateLimitCheckInProgress = false;
const sjb_RATE_LIMIT_CACHE_MS = 10000; // Cache for 10 seconds

function normalizeNoticePeriod(noticePeriodText) {
  if (!noticePeriodText) return "";

  const text = noticePeriodText.trim();

  // Check for "Immediate Joiner" or similar immediate patterns
  if (/immediate\s+join/i.test(text)) {
    return "0M";
  }

  // Extract months pattern
  const monthMatch = text.match(/(\d+)\s*month/i);
  if (monthMatch) {
    const months = parseInt(monthMatch[1], 10);
    return `${months}M`;
  }

  // Extract weeks pattern
  const weekMatch = text.match(/(\d+)\s*week/i);
  if (weekMatch) {
    const weeks = parseInt(weekMatch[1], 10);
    const days = weeks * 7; // Convert weeks to days
    return `${days}D`;
  }

  // Extract days pattern
  const dayMatch = text.match(/(\d+)\s*day/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    return `${days}D`;
  }

  // If no pattern matches, return the original text
  return text;
}

function normalizeModifiedAt(dateText) {
  if (!dateText) return "";

  const text = dateText.trim();

  // Try DD-MMM-YYYY
  const dateMatch1 = text.match(/(\d{1,2})[-/](\w{3})[-/](\d{4})/i);
  if (dateMatch1) {
    const day = parseInt(dateMatch1[1], 10);
    const monthName = dateMatch1[2];
    const year = parseInt(dateMatch1[3], 10);
    const month = getMonthNumber(monthName);
    if (month !== -1) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  // Try MMM DD, YYYY
  const dateMatch2 = text.match(/(\w{3})\s+(\d{1,2}),?\s+(\d{4})/i);
  if (dateMatch2) {
    const monthName = dateMatch2[1];
    const day = parseInt(dateMatch2[2], 10);
    const year = parseInt(dateMatch2[3], 10);
    const month = getMonthNumber(monthName);
    if (month !== -1) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  return "";
}

function normalizeDateOfBirth(dobText) {
  if (!dobText) return "";

  const text = dobText.trim();

  // If already in yyyy-mm-dd format, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  // Pattern 1: DD-MM-YYYY or DD/MM/YYYY
  const ddmmyyyyMatch = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (ddmmyyyyMatch) {
    const day = parseInt(ddmmyyyyMatch[1], 10);
    const month = parseInt(ddmmyyyyMatch[2], 10);
    const year = parseInt(ddmmyyyyMatch[3], 10);

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");

      const date = new Date(year, month - 1, day);
      if (date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  // Pattern 2: DD-MMM-YYYY or DD/MMM/YYYY
  const ddmmyyyyMatch2 = text.match(/^(\d{1,2})[-/](\w{3,})[-/](\d{4})$/i);
  if (ddmmyyyyMatch2) {
    const day = parseInt(ddmmyyyyMatch2[1], 10);
    const monthName = ddmmyyyyMatch2[2];
    const year = parseInt(ddmmyyyyMatch2[3], 10);
    const month = getMonthNumber(monthName);

    if (month !== -1 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");

      const date = new Date(year, month - 1, day);
      if (date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  // Pattern 3: MMM DD, YYYY
  const mmmddyyyyMatch = text.match(/^(\w{3,})\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (mmmddyyyyMatch) {
    const monthName = mmmddyyyyMatch[1];
    const day = parseInt(mmmddyyyyMatch[2], 10);
    const year = parseInt(mmmddyyyyMatch[3], 10);
    const month = getMonthNumber(monthName);

    if (month !== -1 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");

      const date = new Date(year, month - 1, day);
      if (date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  // Pattern 4: DD MMM YYYY
  const ddmmyyyyMatch3 = text.match(/^(\d{1,2})\s+(\w{3,})\s+(\d{4})$/i);
  if (ddmmyyyyMatch3) {
    const day = parseInt(ddmmyyyyMatch3[1], 10);
    const monthName = ddmmyyyyMatch3[2];
    const year = parseInt(ddmmyyyyMatch3[3], 10);
    const month = getMonthNumber(monthName);

    if (month !== -1 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      const yyyy = String(year).padStart(4, "0");
      const mm = String(month).padStart(2, "0");
      const dd = String(day).padStart(2, "0");

      const date = new Date(year, month - 1, day);
      if (date.getDate() === day && date.getMonth() === month - 1 && date.getFullYear() === year) {
        return `${yyyy}-${mm}-${dd}`;
      }
    }
  }

  return "";
}

function getMonthNumber(monthName) {
  const months = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  return months[monthName.toLowerCase()] || -1;
}

function parseEducationDates(durationText) {
  if (!durationText) return { start_date: "", completion_date: "" };

  const text = durationText.trim();

  // Check if there's a "-" separator
  if (text.includes("-")) {
    const parts = text.split("-").map((p) => p.trim());
    const beforeDash = parts[0] || "";
    const afterDash = parts[1] || "";

    let start_date = "";
    let completion_date = "";

    const beforeYearMatch = beforeDash.match(/^\d{4}$/);
    if (beforeYearMatch) {
      start_date = beforeYearMatch[0];
    }

    const afterYearMatch = afterDash.match(/^\d{4}$/);
    if (afterYearMatch) {
      completion_date = afterYearMatch[0];
    }

    return { start_date, completion_date };
  }

  const yearMatch = text.match(/^\d{4}$/);
  if (yearMatch) {
    return { start_date: "", completion_date: yearMatch[0] };
  }

  return { start_date: "", completion_date: "" };
}

async function sSprofile() {
  const sjbProfile = {
    sjbProfileUniqID: "",
    shineCandidateId: "",
    name: "",
    profilePic: "",
    location: "",
    noticePeriod: "",
    totalExp: "",
    linkedin_url: "",
    expectPackage: "",
    prefLocation: "",
    highestDegree: "",
    currentlyWorkingAs: "",
    phone: "",
    email: "",
    about: "",
    workSummary: "",
    industry: "",
    department: "",
    role: "",
    designation: "",
    skills: [],
    experiences: [],
    educations: [],
    licensesAndCertifications: [],
    languages: [],
    dob: "",
    gender: "",
    maritalStatus: "",
    category: "",
    teamHandled: "",
    functionalArea: "",
    shiftType: "",
    physicallyChallanged: "",
    jobType: "",
    employmentStatus: "",
    lastActive: "",
    modifiedAt: "",
    expectedCtc: "",
    resume: {},
    projects: [],
    source: "SJ",
    timestamp: new Date().toISOString(),
    url: window.location.href,
  };

  const urlPath = window.location.pathname;
  const profileIdMatch = urlPath.match(/\/search\/profile\/([^/]+)/);
  if (profileIdMatch) {
    sjbProfile.sjbProfileUniqID = profileIdMatch[1];
  }

  const idDiv = document.querySelector('div[id^="id_profile_shine_"]');
  sjbProfile.sjbProfileUniqID = idDiv ? idDiv.id.replace("id_profile_shine_", "") : "";

  // Extract data-cid (candidate ID) from link element - this is the unique Shine ID
  const candidateLink =
    document.querySelector("a.cls_circle_name.cls_loadProfile[data-cid]") ||
    document.querySelector("a[data-cid]") ||
    document.querySelector("a.cls_loadProfile[data-cid]");
  sjbProfile.shineCandidateId = candidateLink ? candidateLink.getAttribute("data-cid") || "" : "";

  const profileImg = document.querySelector(".profile_picture_profile_detail img");
  sjbProfile.profilePic = profileImg ? profileImg.src : "";

  sjbProfile.name = document.querySelector(".profile_name")?.innerText.trim() || "";

  sjbProfile.location =
    document.querySelector(".location")?.getAttribute("title")?.trim() ||
    document.querySelector(".location")?.innerText.trim() ||
    "";

  const jobTittleSpans = document.querySelectorAll(".job-tittle span");
  sjbProfile.designation = jobTittleSpans[0]?.innerText.trim() || "";
  sjbProfile.role = sjbProfile.designation || "";
  let currentlyWorkingAs = "";
  if (jobTittleSpans.length >= 2) {
    currentlyWorkingAs = `${jobTittleSpans[0]?.innerText.trim()} - ${jobTittleSpans[1]?.innerText.trim()}`;
  } else if (jobTittleSpans.length === 1) {
    currentlyWorkingAs = jobTittleSpans[0]?.innerText.trim();
  }
  sjbProfile.currentlyWorkingAs = currentlyWorkingAs;

  sjbProfile.totalExp = document.querySelector(".years")?.innerText.trim() || "";

  sjbProfile.expectPackage = document.querySelector(".salary")?.innerText.trim() || "";

  // Extract current_ctc from .salary element
  const salaryEl = document.querySelector("li.salary");
  if (salaryEl) {
    sjbProfile.currentCtc = salaryEl.innerText.trim() || salaryEl.textContent.trim() || "";
  }

  // Extract notice period - get text content excluding the strong tag
  const noticePeriodEl = document.querySelector(".notice-period");
  if (noticePeriodEl) {
    const strongEl = noticePeriodEl.querySelector("strong");
    let noticePeriodText = noticePeriodEl.innerText || noticePeriodEl.textContent || "";
    if (strongEl) {
      noticePeriodText = noticePeriodText.replace(strongEl.innerText, "").trim();
    } else {
      noticePeriodText = noticePeriodText.replace(/Notice Period/gi, "").trim();
    }
    sjbProfile.noticePeriod = normalizeNoticePeriod(noticePeriodText);
  } else {
    sjbProfile.noticePeriod = "";
  }

  // Extract last_active and modified_at from active-i-style element
  const activeStyleEl = document.querySelector("i.active-i-style");
  if (activeStyleEl) {
    const activeText = activeStyleEl.innerText || activeStyleEl.textContent || "";

    const activeMatch = activeText.match(/Active:\s*([^\n\r<]+)/i);
    if (activeMatch) {
      sjbProfile.lastActive = normalizeModifiedAt(activeMatch[1].trim());
    }

    const updatedMatch = activeText.match(/Updated\s*:\s*([^\n\r<]+)/i);
    if (updatedMatch) {
      sjbProfile.modifiedAt = normalizeModifiedAt(updatedMatch[1].trim());
    }
  }

  sjbProfile.linkedin_url =
    document
      .querySelector('ul.profile_social_icons li[title="Linkedin"] a[href*="linkedin.com"]')
      ?.getAttribute("href") || "";

  // Extract WhatsApp number from wa.me links
  const whatsappLink =
    document.querySelector('a.wh_icon[href*="wa.me"]') ||
    document.querySelector('a[class*="wh_icon"][href*="wa.me"]') ||
    document.querySelector('a[href*="wa.me"]');

  if (whatsappLink) {
    const whatsappHref = whatsappLink.getAttribute("href") || "";
    const waMeMatch = whatsappHref.match(/wa\.me\/([+\d]+)/);
    if (waMeMatch && waMeMatch[1]) {
      let phoneNumber = waMeMatch[1].trim();
      if (!phoneNumber.startsWith("+")) {
        phoneNumber = `+${phoneNumber}`;
      }
      sjbProfile.phone = phoneNumber;
    }
  }

  // Extract phone and email from profile_right em elements
  const ems = document.querySelectorAll(".profile_right em");

  // Fallback to regular phone extraction if WhatsApp not found
  if (!sjbProfile.phone) {
    sjbProfile.phone = ems[0]?.innerText.trim() || "";
  }

  sjbProfile.email = ems[1]?.innerText.trim() || "";

  // Extract professional summary from experience_box
  const aboutSelectors = [
    ".profile .experience_box p",
    ".experience_box p",
    ".profile .experience_box",
    ".experience_box",
  ];

  for (const selector of aboutSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      if (element.tagName === "P") {
        sjbProfile.about = (element.innerText || element.textContent || "").trim();
      } else {
        const pTag = element.querySelector("p");
        if (pTag) {
          sjbProfile.about = (pTag.innerText || pTag.textContent || "").trim();
        } else {
          sjbProfile.about = (element.innerText || element.textContent || "").trim();
        }
      }
      if (sjbProfile.about) break;
    }
  }

  sjbProfile.experiences = Array.from(document.querySelectorAll(".profile > h2.unmark_this"))
    .filter((h2) => h2.innerText.trim().toLowerCase() === "experience")
    .flatMap((h2) => {
      const profileDiv = h2.closest(".profile");
      if (!profileDiv) return [];
      return Array.from(profileDiv.querySelectorAll(".experience_box")).map((box) => {
        const title = box.querySelector("h3")?.innerText.trim() || "";
        const company = box.querySelector(".sub-tittle")?.innerText.trim() || "";
        const dateRangeText =
          box.querySelector(".w-30.float-left .pb-10")?.innerText.replace(/\s+/g, " ").trim() ||
          "";
        let startDate = "",
          endDate = "";
        if (dateRangeText) {
          const match = dateRangeText.match(/([A-Za-z]+ \d{4})\s*-\s*([A-Za-z]+ \d{4}|Present)/);
          if (match) {
            startDate = match[1];
            endDate = match[2];
          }
        }
        const duration =
          box.querySelector(".w-30.float-left .pb-0")?.innerText.replace(/\s+/g, " ").trim() || "";
        const industry =
          Array.from(box.querySelectorAll("li strong")).find((el) =>
            el.innerText.toLowerCase().includes("industry")
          )?.nextElementSibling?.innerText.trim() || "";
        const department =
          Array.from(box.querySelectorAll("li strong")).find((el) =>
            el.innerText.toLowerCase().includes("functional area")
          )?.nextElementSibling?.innerText.trim() || "";
        const location = sjbProfile.location;

        // Extract Roles & Responsibilities (work_summary)
        let workSummary = "";
        const rolesSection = Array.from(
          box.querySelectorAll(".clearfix.mt-10, div[class*=\"clearfix\"]")
        ).find((div) => {
          const strongTag = div.querySelector("strong");
          if (!strongTag) return false;
          const strongText =
            (strongTag.innerText.toLowerCase() || strongTag.textContent.toLowerCase() || "");
          return (
            strongText.includes("roles") ||
            strongText.includes("responsibilities") ||
            strongText.includes("role") ||
            strongText.includes("&")
          );
        });

        if (rolesSection) {
          const pTag = rolesSection.querySelector("p");
          if (pTag) {
            workSummary = (pTag.innerText || pTag.textContent || "").trim();
          } else {
            const strongTag = rolesSection.querySelector("strong");
            const strongText = strongTag ? (strongTag.innerText || strongTag.textContent || "").trim() : "";
            workSummary = (rolesSection.innerText || rolesSection.textContent || "").trim();
            if (strongText && workSummary.toLowerCase().startsWith(strongText.toLowerCase())) {
              workSummary = workSummary.substring(strongText.length).trim();
            }
            workSummary = workSummary
              .replace(/^(Roles?\s*[&]\s*Responsibilities?[:\s]*)/i, "")
              .trim();
          }
        }

        // Extract Skills from experience box
        let workExperienceSkills = [];
        const skillsSection = Array.from(
          box.querySelectorAll(".clearfix.mt-10, div[class*=\"clearfix\"]")
        ).find((div) => {
          const strongTag = div.querySelector("strong");
          if (!strongTag) return false;
          const strongText = strongTag.innerText.toLowerCase() || strongTag.textContent.toLowerCase() || "";
          return strongText.includes("skills");
        });

        if (skillsSection) {
          const skillSpans = skillsSection.querySelectorAll("p span, span");
          skillSpans.forEach((span) => {
            if (span.closest("strong")) {
              return;
            }
            const skillText = (span.innerText || span.textContent || "").trim();
            if (skillText && skillText.length > 0 && !skillText.toLowerCase().includes("skills:")) {
              workExperienceSkills.push(skillText);
            }
          });

          if (workExperienceSkills.length === 0) {
            const pTag = skillsSection.querySelector("p");
            if (pTag) {
              const pText = (pTag.innerText || pTag.textContent || "").trim();
              const skillsText = pText.replace(/^Skills:\s*/i, "").trim();
              if (skillsText) {
                workExperienceSkills = skillsText
                  .split(",")
                  .map((skill) => skill.trim())
                  .filter((skill) => skill.length > 0 && !skill.toLowerCase().includes("skills:"));
              }
            }
          }
        }

        return {
          title,
          company,
          startDate,
          endDate,
          duration,
          industry,
          department,
          location,
          workSummary,
          workExperienceSkills,
        };
      });
    });

  // Extract skills with years_of_experience for shine (sj) only
  const skillsList = document.querySelectorAll(".profileData_skillsInnerList > li");
  sjbProfile.skills = Array.from(skillsList)
    .map((li) => {
      const skillTxtEl = li.querySelector(".profileData_skillsTxt");
      let skillName = "";
      if (skillTxtEl) {
        skillName = (skillTxtEl.textContent || skillTxtEl.innerText || "").trim();
        skillName = skillName.replace(/\s+/g, " ").trim();
      }

      const yearsTxtEl = li.querySelector(".profileData_skillsSubTxt");
      let yearsOfExperience = "";
      if (yearsTxtEl) {
        const yearsText = (yearsTxtEl.textContent || yearsTxtEl.innerText || "").trim();
        const yearsMatch = yearsText.match(/(\d+\.?\d*)\s*Y/i);
        if (yearsMatch && yearsMatch[1]) {
          yearsOfExperience = yearsMatch[1];
        }
      }

      return {
        category: "General",
        skill_name: skillName,
        proficiency: "",
        years_of_experience: yearsOfExperience,
      };
    })
    .filter((skill) => skill.skill_name && skill.skill_name.length > 0);

  sjbProfile.educations = Array.from(document.querySelectorAll(".profile_education .education > li")).map((li) => {
    const course = li.querySelector("h3")?.childNodes[0]?.textContent.trim() || "";
    const instituteName = li.querySelector(".sub-tittle")?.innerText.trim() || "";
    const durationElement = li.querySelector(".pb-5.fs-13") || li.querySelector(".fs-13");
    const duration = durationElement?.innerText.trim() || durationElement?.textContent.trim() || "";

    const { start_date, completion_date } = parseEducationDates(duration);

    return {
      course,
      instituteName,
      duration,
      start_date,
      completion_date,
    };
  });

  sjbProfile.projects = Array.from(document.querySelectorAll(".profile > h2.unmark_this"))
    .filter((h2) => h2.innerText.trim().toLowerCase() === "projects")
    .flatMap((h2) => {
      const profileDiv = h2.closest(".profile");
      if (!profileDiv) return [];
      return Array.from(profileDiv.querySelectorAll(".experience_box")).map((box) => {
        const projectName = box.querySelector("h3")?.innerText.trim() || "";
        const description =
          Array.from(box.querySelectorAll("p"))
            .find((p) => p.innerText.toLowerCase().includes("description"))
            ?.innerText.replace(/^Description:/i, "")
            .trim() || "";
        const techStack =
          Array.from(box.querySelectorAll("p strong"))
            .find((strong) => strong.innerText.toLowerCase().includes("skills"))
            ?.parentElement?.querySelector("span")
            ?.innerText.trim() || "";
        return { projectName, description, techStack };
      });
    });

  sjbProfile.licensesAndCertifications = Array.from(document.querySelectorAll(".profile > h2.unmark_this"))
    .filter((h2) => h2.innerText.trim().toLowerCase() === "certifications")
    .flatMap((h2) => {
      const profileDiv = h2.closest(".profile");
      if (!profileDiv) return [];
      return Array.from(profileDiv.querySelectorAll(".certificate li")).map((li) => {
        const titleEl = li.querySelector("h3");
        let title = titleEl?.innerText.trim() || "";
        title = title.replace(/\s*-\s*\d{4}\s*$/, "").trim();
        const yearEl = titleEl?.querySelector(".year");
        const year = yearEl ? yearEl.textContent.replace(/[^\d]/g, "").trim() : "";
        return { title, year };
      });
    });

  // Try multiple selectors for resume link
  const resumeLink =
    document.querySelector('.resume-header a[name="download_profile"]') ||
    document.querySelector('.resume-header a[href*="download"]') ||
    document.querySelector('a[href*="download_profile"]') ||
    document.querySelector('a[href*="resume"]');

  if (resumeLink) {
    let href = resumeLink.getAttribute("href");

    if (href && !href.startsWith("http")) {
      href = window.location.origin + href;
    }

    sjbProfile.resume = href;

    // Download the CV and convert to base64
    try {
      const pdfData = await downloadAndConvertCV(href, sjbProfile.name);
      if (pdfData) {
        sjbProfile.resumePdfData = pdfData;
        sjbProfile.resumeFileName = `${sjbProfile.name.replace(/[^a-zA-Z0-9]/g, "_")}_resume.pdf`;
      }
    } catch (error) {
      console.error("Error downloading CV:", error);
    }
  }

  // Extract preferred location from pref__text element
  const prefTextEl = document.querySelector("span.pref__text");
  if (prefTextEl) {
    const strongEl = prefTextEl.querySelector("strong");
    let prefLocationText = prefTextEl.innerText || prefTextEl.textContent || "";
    if (strongEl) {
      prefLocationText = prefLocationText.replace(strongEl.innerText, "").trim();
    }
    if (prefLocationText) {
      sjbProfile.prefLocation = prefLocationText;
    }
  }

  const desiredJobDetails = Array.from(document.querySelectorAll(".profile h2.unmark_this")).find(
    (h2) => h2.innerText.trim().toLowerCase() === "desired job details"
  );
  if (desiredJobDetails) {
    const ul = desiredJobDetails.closest(".profile")?.querySelector("ul.single-list");
    if (ul) {
      Array.from(ul.querySelectorAll("li")).forEach((li) => {
        const label = li.querySelector("strong")?.innerText.trim().toLowerCase();
        const value = li.querySelector("em")?.innerText.trim();
        if (label && value) {
          if (label.includes("job location") && !sjbProfile.prefLocation) {
            sjbProfile.prefLocation = value;
          }
          if (label.includes("industry")) sjbProfile.industry = value;
          if (label.includes("job type")) sjbProfile.jobType = value;
          if (label.includes("shift type") || label.includes("shift")) sjbProfile.shiftType = value;
        }
      });
    }
  }

  const moreDetails = document.querySelectorAll(".profile h2.unmark_this");
  moreDetails.forEach((h2) => {
    if (h2.innerText.trim().toLowerCase() === "more details") {
      const ul = h2.closest(".profile")?.querySelector("ul.half-list");
      if (ul) {
        Array.from(ul.querySelectorAll("li")).forEach((li) => {
          const strongEl = li.querySelector("strong");
          const spanEl = li.querySelector("span");

          const label = strongEl?.innerText.trim().replace(/[:：]/g, "").toLowerCase() || "";
          let value = spanEl?.innerText.trim() || "";
          if (!value && strongEl) {
            const textAfterStrong = li.innerText.trim();
            const strongText = strongEl.innerText.trim();
            if (textAfterStrong.startsWith(strongText)) {
              value = textAfterStrong.substring(strongText.length).trim();
            }
          }

          if (label && value) {
            if (label.includes("date of birth")) {
              sjbProfile.dob = normalizeDateOfBirth(value);
            }
            if (label.includes("gender")) sjbProfile.gender = value;
            if (label.includes("marital status")) sjbProfile.maritalStatus = value;
            if (label.includes("nationality")) sjbProfile.nationality = value;
            if (label.includes("category")) sjbProfile.category = value;
            if (label.includes("team handled")) sjbProfile.teamHandled = value;
            if (label.includes("functional area")) sjbProfile.functionalArea = value;
            if (label.includes("shift type") || label.includes("shift")) sjbProfile.shiftType = value;
          }
        });
      }
    }
  });

  const transformedProfile = transformSjbProfile(sjbProfile);
  window.postMessage({ type: "SJB_PROFILE_DATA", data: transformedProfile }, "*");
  chrome.storage?.local?.set?.({ lastSjbProfile: sjbProfile });
  window.lastScrapedSjbProfile = sjbProfile;
  return sjbProfile;
}

function getJobBoardFromUrl() {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname.includes("naukri.com")) {
    return "NJ";
  }
  if (hostname.includes("shine.com")) {
    return "SJ";
  }
  return hostname.includes("naukri") ? "NJ" : "SJ";
}

async function checkRateLimit() {
  const jobBoard = getJobBoardFromUrl();
  return new Promise((resolve) => {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ canScrape: false, reason: "RUNTIME_UNAVAILABLE" });
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: "CHECK_CAN_SCRAPE",
          jobBoard: jobBoard,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              canScrape: false,
              reason: "MESSAGE_ERROR",
              maxLimit: 0,
              used: 0,
              remaining: 0,
            });
          } else if (response) {
            resolve(response);
          } else {
            resolve({
              canScrape: false,
              reason: "NO_RESPONSE",
              maxLimit: 0,
              used: 0,
              remaining: 0,
            });
          }
        }
      );
    } catch {
      resolve({
        canScrape: false,
        reason: "EXCEPTION",
        maxLimit: 0,
        used: 0,
        remaining: 0,
      });
    }
  });
}

function showRateLimitOverlay(limitInfo) {
  if (sjb_rateLimitOverlay) return;

  const reasonText =
    limitInfo.reason === "DAILY_LIMIT_EXCEEDED"
      ? "Daily candidate view limit exceeded"
      : limitInfo.reason === "WEEKLY_LIMIT_EXCEEDED"
        ? "Weekly candidate view limit exceeded"
        : limitInfo.reason === "MONTHLY_LIMIT_EXCEEDED"
          ? "Monthly candidate view limit exceeded"
          : "candidate view limit exceeded";

  const periodText =
    limitInfo.period === "daily"
      ? "today"
      : limitInfo.period === "weekly"
        ? "this week"
        : limitInfo.period === "monthly"
          ? "this month"
          : "";

  sjb_rateLimitOverlay = document.createElement("div");
  sjb_rateLimitOverlay.id = "etica-rate-limit-overlay";
  sjb_rateLimitOverlay.innerHTML = `
    <div style="
      background: #fff;
      padding: 32px;
      border-radius: 12px;
      text-align: center;
      max-width: 450px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 8px 32px rgba(0,0,0,0.2);
    ">
      <div style="font-size: 48px; margin-bottom: 16px;">⛔</div>
      <h2 style="margin: 0 0 16px 0; color: #d32f2f; font-size: 24px; font-weight: 600;">
        candidate view limit Reached
      </h2>
      <p style="margin: 0 0 24px 0; color: #666; font-size: 16px; line-height: 1.5;">
        ${reasonText} ${periodText ? `(${periodText})` : ""}. 
        You have used ${limitInfo.used || 0} of ${limitInfo.maxLimit || 0} allowed scrapes.
      </p>
      <div style="
        background: #f5f5f5;
        padding: 16px;
        border-radius: 8px;
        margin-bottom: 16px;
        font-size: 14px;
        color: #333;
      ">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>Used:</span>
          <strong>${limitInfo.used || 0} / ${limitInfo.maxLimit || 0}</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Remaining:</span>
          <strong style="color: ${(limitInfo.remaining || 0) > 0 ? "#4caf50" : "#d32f2f"}">${limitInfo.remaining || 0}</strong>
        </div>
      </div>
      <p style="margin: 0; color: #999; font-size: 14px;">
        Please wait until the limit resets to continue scraping.
      </p>
    </div>
  `;

  Object.assign(sjb_rateLimitOverlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0, 0, 0, 0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "999999",
    backdropFilter: "blur(4px)",
  });

  document.body.appendChild(sjb_rateLimitOverlay);
  document.body.style.overflow = "hidden";
}

function hideRateLimitOverlay() {
  if (sjb_rateLimitOverlay) {
    sjb_rateLimitOverlay.remove();
    sjb_rateLimitOverlay = null;
  }
  unblockAllInteractions();
}

let sjb_blockedEventListeners = [];

function blockAllInteractions() {
  unblockAllInteractions();

  const blockEvent = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return false;
  };

  const events = [
    "click",
    "dblclick",
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseenter",
    "mouseleave",
    "mouseover",
    "mouseout",
    "keydown",
    "keyup",
    "keypress",
    "wheel",
    "scroll",
    "touchstart",
    "touchend",
    "touchmove",
    "touchcancel",
    "contextmenu",
    "selectstart",
    "dragstart",
    "drag",
    "dragend",
    "drop",
    "focus",
    "blur",
    "input",
    "change",
    "submit",
    "reset",
  ];

  events.forEach((eventType) => {
    const handler = (e) => {
      blockEvent(e);
      return false;
    };
    document.addEventListener(eventType, handler, { capture: true, passive: false });
    window.addEventListener(eventType, handler, { capture: true, passive: false });
    sjb_blockedEventListeners.push({ element: document, eventType, handler });
    sjb_blockedEventListeners.push({ element: window, eventType, handler });
  });

  document.body.style.overflow = "hidden";
  document.documentElement.style.overflow = "hidden";
  document.body.style.position = "fixed";
  document.body.style.width = "100%";
  document.body.style.height = "100%";

  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
}

function unblockAllInteractions() {
  sjb_blockedEventListeners.forEach(({ element, eventType, handler }) => {
    element.removeEventListener(eventType, handler, { capture: true });
  });
  sjb_blockedEventListeners = [];

  document.body.style.overflow = "";
  document.documentElement.style.overflow = "";
  document.body.style.position = "";
  document.body.style.width = "";
  document.body.style.height = "";
}

async function checkAndBlockIfNeeded() {
  if (sjb_rateLimitCheckInProgress) {
    let waitCount = 0;
    while (sjb_rateLimitCheckInProgress && waitCount < 50) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
      waitCount++;
    }
    if (sjb_lastRateLimitCheck) {
      return sjb_lastRateLimitCheck.result;
    }
  }

  const now = Date.now();
  if (sjb_lastRateLimitCheck && now - sjb_lastRateLimitCheck.timestamp < sjb_RATE_LIMIT_CACHE_MS) {
    return sjb_lastRateLimitCheck.result;
  }

  try {
    sjb_rateLimitCheckInProgress = true;
    const result = await checkRateLimit();
    sjb_rateLimitInfo = result;

    const canScrape = result.canScrape !== false;

    sjb_lastRateLimitCheck = {
      timestamp: now,
      result: canScrape,
    };

    if (!result.canScrape) {
      // Do not show popup or freeze for unauthorized / 0/0 (e.g. 401 on another device)
      const isUnauthorizedStyle =
        result.reason === "UNAUTHORIZED" ||
        (Number(result.used) === 0 && Number(result.maxLimit) === 0);
      if (isUnauthorizedStyle) {
        sjb_isRateLimitBlocked = false;
        hideRateLimitOverlay();
        return true;
      }
      sjb_isRateLimitBlocked = true;
      showRateLimitOverlay(result);
      blockAllInteractions();
      return false;
    }

    sjb_isRateLimitBlocked = false;
    hideRateLimitOverlay();
    if (typeof window.unfreezePage === "function") {
      window.unfreezePage();
    }
    if (typeof window.disableBlock === "function") {
      window.disableBlock();
    }
    return true;
  } catch (error) {
    console.error("[SJB Rate Limit] Error checking rate limit:", error);
    sjb_isRateLimitBlocked = true;
    sjb_rateLimitInfo = {
      canScrape: false,
      reason: "CHECK_ERROR",
      maxLimit: 0,
      used: 0,
      remaining: 0,
    };
    showRateLimitOverlay(sjb_rateLimitInfo);
    blockAllInteractions();
    return false;
  } finally {
    sjb_rateLimitCheckInProgress = false;
  }
}

function handleSc() {
  const isProfilePage = typeof window.isSjbProfilePage === "function" ? window.isSjbProfilePage() : false;

  if (sjbProfileScraped || sjbScrapingInProgress || !isProfilePage) {
    return;
  }

  sjbScrapingInProgress = true;
  sjbProfileScraped = true;
  window.removeEventListener("scroll", handleSc, { passive: true });

  checkAndBlockIfNeeded()
    .then((canScrape) => {
      if (!canScrape) {
        sjbScrapingInProgress = false;
        sjbProfileScraped = false;
        return;
      }

      const firstCheckResult = canScrape;
      const firstCheckTime = Date.now();

      setTimeout(async () => {
        const timeSinceFirstCheck = Date.now() - firstCheckTime;
        let canScrapeNow = firstCheckResult;

        if (timeSinceFirstCheck > 10000) {
          canScrapeNow = await checkAndBlockIfNeeded();
        }

        if (!canScrapeNow) {
          sjbScrapingInProgress = false;
          sjbProfileScraped = false;
          return;
        }

        try {
          const sjbProfile = await sSprofile();

          const transformedProfile = transformSjbProfile(sjbProfile);
          sendMessageSafely({
            type: "SJB_PROFILE",
            data: transformedProfile,
            resumePdfData: sjbProfile.resumePdfData || null,
            resumeFileName: sjbProfile.resumeFileName || null,
          });
        } catch (error) {
          console.error("[SJB] Error during scraping:", error);
        } finally {
          sjbScrapingInProgress = false;
        }
      }, 5000);
    })
    .catch((error) => {
      console.error("[SJB] Error in rate limit check:", error);
      sjbScrapingInProgress = false;
      sjbProfileScraped = false;
    });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SJB_PROFILE_SUCCESS") {
    // success acknowledgement
  }

  if (message.type === "SJB_PROFILE_ERROR") {
    // ignore
  }

  // Trigger resume upload after profile is saved
  if (message.type === "SJB_TRIGGER_RESUME_UPLOAD") {
    if (message.candidateId && message.resumePdfData) {
      const cvUpdatedAt =
        (window.lastScrapedSjbProfile &&
          window.lastScrapedSjbProfile.modifiedAt &&
          window.lastScrapedSjbProfile.modifiedAt.trim()) ||
        "";

      sendMessageSafely({
        type: "SJB_UPDATE_RESUME",
        data: {
          candidate_id: message.candidateId,
          resumePdfData: message.resumePdfData,
          resumeFileName: message.resumeFileName,
          cv_updated_at: cvUpdatedAt,
        },
      });
    }
  }

  if (message.type === "SJB_RESUME_UPDATE_SUCCESS") {
    // ignore
  }

  if (message.type === "SJB_RESUME_UPDATE_ERROR") {
    // ignore
  }
});

// Check if this is a SJB profile page and attach scroll listener
if (typeof window.isSjbProfilePage === "function" && window.isSjbProfilePage()) {
  window.addEventListener("scroll", handleSc, { passive: true });
}

async function initializeRateLimitCheck() {
  if (sjb_rateLimitCheckInProgress) {
    return;
  }

  const now = Date.now();
  if (sjb_lastRateLimitCheck && now - sjb_lastRateLimitCheck.timestamp < sjb_RATE_LIMIT_CACHE_MS) {
    return sjb_lastRateLimitCheck.result;
  }

  sjb_rateLimitCheckInProgress = true;
  try {
    const canScrape = await checkAndBlockIfNeeded();
    sjb_lastRateLimitCheck = {
      timestamp: now,
      result: canScrape,
    };
    return canScrape;
  } finally {
    sjb_rateLimitCheckInProgress = false;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeRateLimitCheck, { once: true });
} else {
  initializeRateLimitCheck();
}

const sjb_handleNavigation = async () => {
  sjbProfileScraped = false;
  sjbScrapingInProgress = false;
  sjb_lastRateLimitCheck = null;
  await checkAndBlockIfNeeded();
};

window.addEventListener(
  "load",
  async () => {
    const now = Date.now();
    if (!sjb_lastRateLimitCheck || now - sjb_lastRateLimitCheck.timestamp >= sjb_RATE_LIMIT_CACHE_MS) {
      await checkAndBlockIfNeeded();
    }
  },
  { once: true }
);

window.addEventListener("beforeunload", () => {
  // state will be checked again on next page load
});

window.addEventListener("popstate", sjb_handleNavigation);
window.addEventListener("pushstate", sjb_handleNavigation);
window.addEventListener("locationchange", sjb_handleNavigation);

// Intercept navigation clicks and block if rate limited
document.addEventListener(
  "click",
  async (e) => {
    if (sjb_isRateLimitBlocked) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return false;
    }

    const link = e.target.closest("a");
    if (link && link.href) {
      const now = Date.now();
      let canScrape = true;

      if (sjb_lastRateLimitCheck && now - sjb_lastRateLimitCheck.timestamp < sjb_RATE_LIMIT_CACHE_MS) {
        canScrape = sjb_lastRateLimitCheck.result;
      } else {
        canScrape = await checkAndBlockIfNeeded();
      }

      if (!canScrape) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        return false;
      }
    }

    return true;
  },
  true
);

window.sSprofile = sSprofile;
window.handleSc = handleSc;
window.sjbProfileScraped = false;


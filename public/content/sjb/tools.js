/* global chrome */

// Content scripts run as classic scripts (no ESM imports). Keep constants inline.
const WEB_APP_URL = "https://dms.eticaatest.co.in";

/**
 * Download CV from URL and convert to base64
 */
async function downloadAndConvertCV(cvUrl, candidateName) {
  try {
    console.log(`Downloading CV for ${candidateName} from:`, cvUrl);

    // Fetch the CV using the current session
    const response = await fetch(cvUrl, {
      method: "GET",
      credentials: "include", // Include cookies for authentication
      headers: {
        Accept: "application/pdf,*/*",
      },
    });

    if (!response.ok) {
      return null;
    }

    // Get the PDF as blob
    const blob = await response.blob();

    // Convert blob to base64
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        // Remove the data:application/pdf;base64, prefix
        const base64Data = reader.result.split(",")[1];
        resolve(base64Data);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error(`Error downloading CV for ${candidateName}:`, error);
    return null;
  }
}

function parseJobAndCompany(text) {
  if (!text) return { job_title: null, company_name: null };

  const cleaned = text.replace(/May also know:/i, "").trim();
  if (!cleaned) return { job_title: null, company_name: cleaned };

  const parts = cleaned
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    // If no pipe found, treat whole as company name
    return { job_title: null, company_name: parts[0] };
  }

  return {
    job_title: parts[0],
    company_name: parts[parts.length - 1],
  };
}

/**
 * Check if current page is a SJB profile page
 * @returns {boolean} True if current page is a SJB profile page
 */
function isSjbProfilePage() {
  // this is converting the hostname and pathname to lower case to compare easily
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname.toLowerCase();

  // Check if domain is Shine-related
  const isShineDomain = hostname.includes("shine.com") || hostname.includes("recruiter.shine.com");

  if (!isShineDomain) {
    return false;
  }

  // Check for profile page indicators
  const hasProfileTop = !!document.querySelector(".profile_top");
  const hasProfilePath = pathname.includes("/search/profile/");
  const hasProfileClass = !!document.querySelector(".profile");

  // Return true if any profile indicator is found
  return hasProfileTop || hasProfilePath || hasProfileClass;
}

function extractProfilePageDetails(container, sjbProfileUniqID) {
  const name = cleanText(container.querySelector(".profile_name")) || null;

  const phone = cleanText(container.querySelector(".new-tick-design-ai em")) || null;

  const email = cleanText(container.querySelector(".new-tick-design-ai + em")) || null;

  // Education text is not clearly structured on profile page
  const educationText = null;

  // Current company from title line
  const companyLine = cleanText(container.querySelector(".job-tittle span:last-child"));
  const currentCompany = companyLine?.replace("-", "").trim() || null;

  void educationText;
  void sjbProfileUniqID;

  return {
    name,
    email,
    phone,
    education: {
      degree: null,
      specialization: null,
      institute_name: null,
    },
    companies: currentCompany
      ? [{ company_name: currentCompany, job_title: null, is_current: true }]
      : [],
  };
}

/**
 * Extract text content from element, removing HTML tags
 */
function cleanText(element) {
  if (!element) return "";
  return element.textContent.trim().replace(/\s+/g, " ");
}

/**
 * Remove <mark> tags but keep the text
 */
function getTextWithoutMarks(element) {
  if (!element) return "";
  const clone = element.cloneNode(true);
  clone.querySelectorAll("mark").forEach((mark) => {
    mark.replaceWith(mark.textContent);
  });
  return cleanText(clone);
}

// ===== DATA EXTRACTION FUNCTIONS =====

/**
 * Extract candidate basic information
 */
function extractBasicInfo(card) {
  const nameElement = card.querySelector(".cls_circle_name.cls_loadProfile");
  const name = cleanText(nameElement);

  const profileLink = nameElement?.href || "";

  // Extract experience, salary, location from the ul.cc list
  const infoList = card.querySelectorAll(".cc li");
  const experience = infoList[0] ? cleanText(infoList[0]).replace("&nbsp;", "").trim() : "";
  const salary = infoList[1] ? cleanText(infoList[1]).replace("&nbsp;", "").trim() : "";
  const location = infoList[2] ? cleanText(infoList[2]).replace("&nbsp;", "").trim() : "";

  return {
    name,
    profileLink,
    experience,
    salary,
    location,
  };
}

/**
 * Extract current and previous company details
 */
function extractCompanyDetails(card) {
  const companySection = card.querySelector(".company-detail");
  if (!companySection) return { current: "", previous: "" };

  const currentElement = companySection.querySelector(".current");
  const previousElement = companySection.querySelector(".grey-light");

  const current = currentElement ? getTextWithoutMarks(currentElement) : "";
  const previous = previousElement ? getTextWithoutMarks(previousElement) : "";

  return {
    currentCompany: current.replace("Current:", "").trim(),
    previousCompany: previous.replace("Previous:", "").trim(),
  };
}

/**
 * Extract education details
 */
function extractEducation(card) {
  const educSection = card.querySelector(".iconWrap.educ");
  if (!educSection) return { primary: "", secondary: "" };

  const primaryElement = educSection.querySelector(".current");
  const secondaryElement = educSection.querySelector(".grey-light");

  const primary = primaryElement ? getTextWithoutMarks(primaryElement) : "";
  const secondary = secondaryElement ? getTextWithoutMarks(secondaryElement) : "";

  return {
    primaryEducation: primary,
    secondaryEducation: secondary,
  };
}

/**
 * Extract preferred location
 */
function extractPreferredLocation(card) {
  const prefElement = card.querySelector(".iconWrap.pref .pref__text");
  if (!prefElement) return "";

  return cleanText(prefElement).replace("Pref. Location:", "").trim();
}

/**
 * Extract skills from the skills section
 */
function extractSkills(card) {
  const skillsList = card.querySelectorAll(".srp_page_language li");
  const skills = [];

  skillsList.forEach((li) => {
    const skillText = getTextWithoutMarks(li);
    if (skillText) {
      skills.push(skillText);
    }
  });

  return skills;
}

/**
 * Extract "may also know" skills
 */
function extractMayAlsoKnowSkills(card) {
  const mayAlsoKnowElement = card.querySelector(".may_also_know__text");
  if (!mayAlsoKnowElement) return [];

  const text = getTextWithoutMarks(mayAlsoKnowElement);
  const cleanedText = text.replace("May also know:", "").trim();

  // Split by comma and clean each skill
  return cleanedText
    .split(",")
    .map((skill) => skill.trim())
    .filter((skill) => skill.length > 0);
}

/**
 * Extract verification status
 */
function extractVerifications(card) {
  const verifiedList = card.querySelectorAll(".list-content__right__bottom--verified li");
  const verifications = {
    aiVerified: false,
    emailVerified: false,
    mobileVerified: false,
    resumeAvailable: false,
  };

  verifiedList.forEach((li) => {
    const tipText = cleanText(li.querySelector(".tip"));
    if (tipText.includes("AI Verified")) verifications.aiVerified = true;
    if (tipText.includes("Email Verified")) verifications.emailVerified = true;
    if (tipText.includes("Mobile Verified")) verifications.mobileVerified = true;
    if (tipText.includes("Resume Available")) verifications.resumeAvailable = true;
  });

  return verifications;
}

/**
 * Extract dates (updated and active)
 */
function extractDates(card) {
  const dateElements = card.querySelectorAll(".list-content__right__bottom--active_date p");
  const updated = dateElements[0] ? cleanText(dateElements[0]).replace("Updated:", "").trim() : "";
  const active = dateElements[1] ? cleanText(dateElements[1]).replace("Active:", "").trim() : "";

  return { updated, active };
}

/**
 * Extract all badges (Immediate Joiner, etc.)
 */
function extractBadges(card) {
  const badges = [];
  const badgeElements = card.querySelectorAll(".display-badge");

  badgeElements.forEach((badge) => {
    badges.push(cleanText(badge));
  });

  return badges;
}

/**
 * Main function to extract complete profile data
 */
function extractProfileData(card, sjbProfileUniqID) {
  const basicInfo = extractBasicInfo(card);
  const company = extractCompanyDetails(card);
  const education = extractEducation(card);
  const preferredLocation = extractPreferredLocation(card);
  const skills = extractSkills(card);
  const mayAlsoKnowSkills = extractMayAlsoKnowSkills(card);
  const verifications = extractVerifications(card);
  const dates = extractDates(card);
  const badges = extractBadges(card);

  return {
    sjbProfileUniqID,
    ...basicInfo,
    ...company,
    ...education,
    preferredLocation,
    skills,
    mayAlsoKnowSkills,
    ...verifications,
    ...dates,
    badges,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get all profile cards from the page using .list-content containers
 * Also handles profile detail pages with .profile_right containers
 */
function getSjbProfiles() {
  const profiles = [];

  // First, try to find profiles in search results (list view)
  const searchContainer = document.querySelector(".insta_search.cls_insta_search");
  if (searchContainer) {
    // Find all .list-content containers inside the search container
    const listContentContainers = searchContainer.querySelectorAll(".list-content");

    listContentContainers.forEach((container) => {
      let sjbProfileUniqID = null;

      // First preference: anchor tag with data-cid attribute
      const anchorTag = container.querySelector("a[data-cid]");
      if (anchorTag) {
        const cid = anchorTag.getAttribute("data-cid");
        if (cid) {
          sjbProfileUniqID = cid;
        }
      }

      // Fallback: extract from element IDs like id_profile_shine_<id>
      if (!sjbProfileUniqID) {
        const directId = container.id;
        const idMatch = directId?.startsWith("id_profile_shine_")
          ? directId
          : container.closest('[id^="id_profile_shine_"]')?.id;

        if (idMatch && idMatch.startsWith("id_profile_shine_")) {
          sjbProfileUniqID = idMatch.replace("id_profile_shine_", "");
        }
      }

      if (sjbProfileUniqID) {
        const profileData = extractProfileData(container, sjbProfileUniqID);
        profiles.push({
          sjbProfileUniqID,
          element: container,
          data: profileData,
        });
      }
    });
  }

  // Also check for profile detail pages (single profile view)
  const profileDetailContainers = document.querySelectorAll(".profile_right, [id^=\"id_profile_shine_\"]");
  profileDetailContainers.forEach((container) => {
    let sjbProfileUniqID = null;

    const directId = container.id;
    if (directId && directId.startsWith("id_profile_shine_")) {
      sjbProfileUniqID = directId.replace("id_profile_shine_", "");
    } else {
      const idElement = container.closest('[id^="id_profile_shine_"]') || container.querySelector('[id^="id_profile_shine_"]');
      if (idElement && idElement.id) {
        sjbProfileUniqID = idElement.id.replace("id_profile_shine_", "");
      }
    }

    // Also check for data-cid in anchor tags
    if (!sjbProfileUniqID) {
      const anchorTag = container.querySelector("a[data-cid]");
      if (anchorTag) {
        const cid = anchorTag.getAttribute("data-cid");
        if (cid) {
          sjbProfileUniqID = cid;
        }
      }
    }

    if (sjbProfileUniqID && !profiles.find((p) => p.sjbProfileUniqID === sjbProfileUniqID)) {
      const profileData = extractProfileData(container, sjbProfileUniqID);
      profiles.push({
        sjbProfileUniqID,
        element: container,
        data: profileData,
      });
    }
  });

  return profiles;
}

/**
 * Add visual badge to matched profiles
 */
function addBadge(profile) {
  // Find the card container (.profile_top for profile detail pages or .list-content for search results)
  let cardContainer = profile.element.querySelector(".profile_top") || profile.element.querySelector(".list-content");

  // If not found in direct children, search in parent elements
  if (!cardContainer) {
    let currentElement = profile.element;
    for (let i = 0; i < 5 && currentElement; i++) {
      cardContainer = currentElement.querySelector(".profile_top") || currentElement.querySelector(".list-content");
      if (cardContainer) break;
      currentElement = currentElement.parentElement;
    }
  }

  // Also check if the element itself is a card container
  if (!cardContainer) {
    if (profile.element.classList.contains("profile_top") || profile.element.classList.contains("list-content")) {
      cardContainer = profile.element;
    }
  }

  if (!cardContainer) return;

  // Check if badge already exists in the card container
  if (cardContainer.querySelector(".sjb-matched-badge")) return;

  // Use card container as the badge host
  const badgeHost = cardContainer;

  const badge = document.createElement("div");
  badge.className = "sjb-matched-badge";

  // Base styles
  const baseStyles = `
    width: 30px;
    height: 30px;
    background-color: #7f56d9;
    border-radius: 50%;
    cursor: pointer;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-weight: bold;
    font-size: 16px;
    line-height: 1;
    box-shadow: 0 4px 10px rgba(0,0,0,0.15);
    animation: pulse 1.8s infinite;
  `;

  // Add checkmark symbol (✓)
  badge.textContent = "✓";

  // Add pulse animation if not already added
  if (!document.getElementById("sjb-pulse-animation")) {
    const style = document.createElement("style");
    style.id = "sjb-pulse-animation";
    style.textContent = `
      @keyframes pulse {
        0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(127, 86, 217, 0.6); }
        50% { transform: scale(1.05); box-shadow: 0 0 0 10px rgba(127, 86, 217, 0); }
        100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(127, 86, 217, 0); }
      }
    `;
    document.head.appendChild(style);
  }

  // Add tooltip
  badge.title = "Already in database - Click to view details";

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    const candidateId = profile.candidateId || profile.sjbProfileUniqID;
    const candidateUrl = `${WEB_APP_URL}/candidate-management/candidate-details/${candidateId}`;
    window.open(candidateUrl, "_blank");
  });

  // Ensure badge host (card container) can position the badge
  const hostComputedStyle = window.getComputedStyle(badgeHost);
  if (hostComputedStyle.position === "static" || !hostComputedStyle.position) {
    badgeHost.style.position = "relative";
  }

  // Position badge at the top-right corner of the card container
  badge.style.cssText =
    baseStyles +
    `
    position: absolute;
    top: 10px;
    right: 10px;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  `;

  badgeHost.appendChild(badge);
}

/**
 * Extract all Shine unique IDs from the page
 */
function extractAllShineIds() {
  const shineIds = [];

  // Find all elements with IDs starting with "id_profile_shine_"
  const allElements = document.querySelectorAll('[id^="id_profile_shine_"]');

  allElements.forEach((element) => {
    const id = element.id;
    if (id && id.startsWith("id_profile_shine_")) {
      const uniqueId = id.replace("id_profile_shine_", "");
      if (uniqueId && !shineIds.includes(uniqueId)) {
        shineIds.push(uniqueId);
      }
    }
  });

  return shineIds;
}

// Flag to prevent concurrent API calls
let isCheckingIds = false;
let checkIdsTimeout = null;

/**
 * Parse education string to extract degree, specialization, and institute
 */
function parseEducation(educationString) {
  if (!educationString) return { degree: null, specialization: null, institute_name: null };

  const parts = educationString.split("|").map((p) => p.trim());

  // Extract degree and specialization from first part
  const degreeMatch = parts[0]?.match(/^(.+?)\s*\((.+?)\)/);
  const degree = degreeMatch ? degreeMatch[1].trim() : parts[0];
  const specialization = degreeMatch ? degreeMatch[2].trim() : null;

  // Institute is second part
  const institute_name = parts[1] || null;

  return { degree, specialization, institute_name };
}

/**
 * Check SJB IDs against database and add badges
 * Debounced to prevent multiple simultaneous calls
 */
function checkSjbIds() {
  if (checkIdsTimeout) {
    clearTimeout(checkIdsTimeout);
    checkIdsTimeout = null;
  }

  if (isCheckingIds) {
    return;
  }

  checkIdsTimeout = setTimeout(() => {
    isCheckingIds = true;

    try {
      setTimeout(() => {
        let profiles;

        try {
          profiles = getSjbProfiles();
        } catch (err) {
          console.error("[SJB] Failed to fetch profiles:", err);
          isCheckingIds = false;
          return;
        }

        if (!profiles || profiles.length === 0) {
          isCheckingIds = false;
          return;
        }

        if (!window?.chrome?.runtime?.sendMessage) {
          isCheckingIds = false;
          return;
        }

        const ids = profiles.map((p) => p.sjbProfileUniqID).filter(Boolean);

        // Extract full profile details for each candidate
        const jobBoardFrontPageDetails = profiles.map((profile) => {
          if (isSjbProfilePage()) {
            // PROFILE PAGE extraction
            return extractProfilePageDetails(profile.element, profile.sjbProfileUniqID);
          }

          // SEARCH PAGE extraction
          const basicInfo = extractBasicInfo(profile.element);
          const company = extractCompanyDetails(profile.element);

          const currentParsed = parseJobAndCompany(company.currentCompany);
          const previousParsed = parseJobAndCompany(company.previousCompany);

          const companies = [
            currentParsed.company_name
              ? {
                  company_name: currentParsed.company_name,
                  job_title: currentParsed.job_title,
                  is_current: true,
                }
              : null,
            previousParsed.company_name
              ? {
                  company_name: previousParsed.company_name,
                  job_title: previousParsed.job_title,
                  is_current: false,
                }
              : null,
          ].filter(Boolean);

          const education = extractEducation(profile.element);
          const parsedEducation = parseEducation(education.primaryEducation);

          return {
            name: basicInfo.name,
            email: null,
            phone: null,
            education: {
              degree: parsedEducation.degree,
              specialization: parsedEducation.specialization,
              institute_name: parsedEducation.institute_name,
            },
            companies,
          };
        });

        if (ids.length === 0) {
          isCheckingIds = false;
          return;
        }

        try {
          window.chrome.runtime.sendMessage(
            {
              action: "CHECK_SJB_IDS",
              ids: ids,
              jobBoardFrontPageDetails: jobBoardFrontPageDetails,
            },
            (response) => {
              isCheckingIds = false;

              if (chrome.runtime?.lastError) {
                return;
              }

              if (!response || !response.matched) {
                return;
              }

              const { byId = [], byName = [] } = response.matched;

              profiles.forEach((profile, idx) => {
                let shouldAddBadge = false;
                let matchInfo = null;

                // Check match by JOB_BOARD_ID using index
                const idMatch = byId.find((m) => m.index === idx);
                if (idMatch) {
                  shouldAddBadge = true;
                  matchInfo = idMatch;
                }

                // Check match by name if not already matched
                if (!shouldAddBadge) {
                  const nameMatch = byName.find((m) => {
                    const profileName = profile.data?.name || extractBasicInfo(profile.element).name;
                    return (
                      profileName &&
                      m.name &&
                      profileName.toLowerCase().trim() === m.name.toLowerCase().trim()
                    );
                  });

                  if (nameMatch) {
                    shouldAddBadge = true;
                    matchInfo = nameMatch;
                  }
                }

                if (shouldAddBadge && matchInfo) {
                  profile.candidateId = matchInfo.candidateId;
                  addBadge(profile);
                }
              });
            }
          );
        } catch (msgErr) {
          console.error("[SJB] sendMessage failed:", msgErr);
          isCheckingIds = false;
        }
      }, 2000);
    } catch (outerErr) {
      console.error("[SJB] Fatal error in checkSjbIds():", outerErr);
      isCheckingIds = false;
    }
  }, 500);
}

/**
 * Initialize observer for dynamic content loading
 */
function initializeObserver() {
  const targetNode = document.querySelector(".insta_search");
  if (!targetNode) {
    setTimeout(initializeObserver, 1000);
    return;
  }

  const observer = new MutationObserver((mutations) => {
    let shouldCheck = false;

    mutations.forEach((mutation) => {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach((node) => {
          if (node.classList && node.classList.contains("cls_loop_chng")) {
            shouldCheck = true;
          }
        });
      }
    });

    if (shouldCheck) {
      checkSjbIds();
    }
  });

  observer.observe(targetNode, {
    childList: true,
    subtree: true,
  });
}

/**
 * Extract Shine IDs and verify them via API
 */
function extractAndVerifyShineIds() {
  checkSjbIds();
}

// Listen for message from background script to extract and verify IDs
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void sender;
    if (message.type === "SJB_EXTRACT_AND_VERIFY_IDS") {
      extractAndVerifyShineIds();
      sendResponse({ status: "processing" });
    }

    // Listen for refresh badges message (sent after profile is saved)
    if (message.type === "SJB_REFRESH_BADGES") {
      // Only refresh on search list pages, not profile pages
      if (!isSjbProfilePage()) {
        checkSjbIds();
      }
      sendResponse({ status: "processing" });
    }
  });
}

/**
 * Trigger CAN_SCRAPE check by sending message to background script
 * @param {string} jobBoard - "NJ" for Naukri, "SJ" for Shine
 */
function triggerCanScrapeCheck(jobBoard) {
  if (!window?.chrome?.runtime?.sendMessage) {
    return;
  }

  try {
    chrome.runtime.sendMessage(
      {
        type: "CHECK_CAN_SCRAPE",
        jobBoard: jobBoard,
      },
      () => {
        // ignore
      }
    );
  } catch {
    // ignore
  }
}

window.downloadAndConvertCV = downloadAndConvertCV;
window.isSjbProfilePage = isSjbProfilePage;
window.getSjbProfiles = getSjbProfiles;
window.extractProfileData = extractProfileData;
window.addBadge = addBadge;
window.checkSjbIds = checkSjbIds;
window.initializeObserver = initializeObserver;
window.extractAllShineIds = extractAllShineIds;
window.extractAndVerifyShineIds = extractAndVerifyShineIds;
window.triggerCanScrapeCheck = triggerCanScrapeCheck;

// ===== AUTO-INITIALIZE =====

// Track current URL and page type to detect navigation
let currentSjbUrl = window.location.href;
let wasOnProfilePage = isSjbProfilePage();

// Function to detect navigation and refresh badges when returning to search list
function handleSjbNavigation() {
  const newUrl = window.location.href;
  const isNowOnProfilePage = isSjbProfilePage();

  // If URL changed
  if (newUrl !== currentSjbUrl) {
    // If we navigated from profile page back to search list page
    if (wasOnProfilePage && !isNowOnProfilePage) {
      // Immediately check CAN_SCRAPE on back navigation
      triggerCanScrapeCheck("SJ");
      // Wait a bit for page to load, then refresh badges
      setTimeout(() => {
        checkSjbIds();
      }, 1000);
    } else if (!isNowOnProfilePage) {
      // If we're on a search list page, refresh badges on navigation
      triggerCanScrapeCheck("SJ");
      setTimeout(() => {
        checkSjbIds();
      }, 1000);
    }

    // Update tracking variables
    currentSjbUrl = newUrl;
    wasOnProfilePage = isNowOnProfilePage;
  }
}

// Monitor URL changes for navigation detection
function setupSjbUrlMonitoring() {
  // Listen to popstate (back/forward navigation)
  window.addEventListener("popstate", () => {
    setTimeout(handleSjbNavigation, 100);
  });

  // Listen to pushstate (programmatic navigation)
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(history, args);
    setTimeout(handleSjbNavigation, 100);
  };

  // Listen to replacestate
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(history, args);
    setTimeout(handleSjbNavigation, 100);
  };

  // Listen to locationchange event (if available)
  window.addEventListener("locationchange", () => {
    setTimeout(handleSjbNavigation, 100);
  });

  // Also listen to visibility change
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !isSjbProfilePage()) {
      triggerCanScrapeCheck("SJ");
      setTimeout(() => {
        checkSjbIds();
      }, 500);
    }
  });
}

// Run on page load
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    checkSjbIds();
    initializeObserver();
    setupSjbUrlMonitoring();
    if (!isSjbProfilePage()) {
      triggerCanScrapeCheck("SJ");
    }
  });
} else {
  checkSjbIds();
  initializeObserver();
  setupSjbUrlMonitoring();
  if (!isSjbProfilePage()) {
    triggerCanScrapeCheck("SJ");
  }
}


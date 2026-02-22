
(() => {
console.log("🟢 Content script initialized");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_SCREEN_INFO") return;
  try {
    const w = typeof window !== "undefined" ? window : null;
    const s = w?.screen || null;
    const width = typeof s?.width === "number" ? s.width : undefined;
    const height = typeof s?.height === "number" ? s.height : undefined;
    const pixelRatio = typeof w?.devicePixelRatio === "number" ? w.devicePixelRatio : undefined;
    sendResponse({
      ...(typeof width === "number" ? { width: Number(width) } : {}),
      ...(typeof height === "number" ? { height: Number(height) } : {}),
      ...(typeof pixelRatio === "number" ? { pixelRatio: Number(pixelRatio) } : {}),
    });
  } catch {
    sendResponse({});
  }
  return true;
});

// --------------------------------------------------------------------------------------
// CAN_SCRAPE (Rate limit) checks for Resdex (Naukri)
// Match Working_extension behavior: check on /v3/search, /v3/preview navigation and
// after interceptor activity. Background freezes ONLY when canScrape === false.
// --------------------------------------------------------------------------------------

function isResdexNaukriRelevantPage() {
  const host = (window.location.hostname || "").toLowerCase();
  if (host !== "resdex.naukri.com") return false;
  const path = (window.location.pathname || "").toLowerCase();
  return path.startsWith("/v3/search") || path.startsWith("/v3/preview");
}

let lastCanScrapeCheckAt = 0;
function triggerResdexCanScrapeCheck(reason = "") {
  if (!isResdexNaukriRelevantPage()) return;
  const now = Date.now();
  // Debounce to avoid spamming on rapid mutations/interceptor bursts.
  if (now - lastCanScrapeCheckAt < 3000) return;
  lastCanScrapeCheckAt = now;

  try {
    chrome.runtime.sendMessage(
      {
        type: "CHECK_CAN_SCRAPE",
        jobBoard: "NJ",
        reason,
      },
      () => {
        // Background decides whether to freeze. No UI work here.
      }
    );
  } catch {
    // ignore
  }
}

// --------------------------------------------------------------------------------------
// Resdex route change detection and verified-ids (same as Working_extension content/njb/tools.js)
// Uses search state from URL (sid, pageNo, so) + popstate/pushState/replaceState/polling/visibility.
// --------------------------------------------------------------------------------------

function isResdexSearchPage() {
  const host = (window.location.hostname || "").toLowerCase();
  if (host !== "resdex.naukri.com") return false;
  const path = (window.location.pathname || "").toLowerCase();
  return path.includes("/v3/search") || path === "/v3/search";
}

function isResdexPreviewPage() {
  const host = (window.location.hostname || "").toLowerCase();
  if (host !== "resdex.naukri.com") return false;
  const path = (window.location.pathname || "").toLowerCase();
  return path.includes("/preview") || path.includes("/profile");
}

/** Extract search state from URL (sid, pageNo, so). Returns { sid, pageNo, so, key } or null. */
function extractSearchState(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname || "";
    if (!pathname.includes("/v3/search") && pathname !== "/v3/search") return null;
    const sid = urlObj.searchParams.get("sid") || "";
    const pageNo = urlObj.searchParams.get("pageNo") || "1";
    const so = urlObj.searchParams.get("so") || "";
    return { sid, pageNo, so, key: `${sid}_${pageNo}_${so}` };
  } catch {
    return null;
  }
}

function hasSearchStateChanged(newState, oldState) {
  if (!newState) return false;
  if (!oldState) return true;
  return newState.key !== oldState.key;
}

function areSearchResultsLoaded() {
  return !!(
    document.querySelector(".list-container") ||
    document.querySelector(".flex-row.tuple-top") ||
    document.querySelector(".search-results") ||
    document.querySelectorAll(".tuple-top").length > 0
  );
}

/** Trigger verified-ids refresh + CAN_SCRAPE on Resdex search page (same points as Working_extension). */
function triggerResdexVerifiedIdsAndCanScrape() {
  if (!cachedAuthToken) return;
  if (!isResdexSearchPage()) return;
  try {
    chrome.runtime.sendMessage(
      { action: "REQUEST_NJB_VERIFIED_IDS_REFRESH", reason: "resdex_route_change" },
      () => {}
    );
  } catch {
    // ignore
  }
  triggerResdexCanScrapeCheck("resdex_search");
}

let resdexCurrentUrl = window.location.href;
let resdexLastSearchState = null;

function triggerApisForResdexSearchPage() {
  if (!isResdexSearchPage() || isResdexPreviewPage()) return false;
  const currentSearchState = extractSearchState(window.location.href);
  const searchStateChanged = hasSearchStateChanged(currentSearchState, resdexLastSearchState);
  if (!searchStateChanged && resdexLastSearchState !== null) return false;

  resdexLastSearchState = currentSearchState;
  triggerResdexVerifiedIdsAndCanScrape();
  return true;
}

function handleResdexUrlChange() {
  const newUrl = window.location.href;
  const newPath = (window.location.pathname || "").toLowerCase();
  const isSearchPage = newPath.includes("/v3/search");
  const isPreviewPage = newPath.includes("/preview") || newPath.includes("/profile");

  if (newUrl === resdexCurrentUrl) return;
  resdexCurrentUrl = newUrl;

  if (isSearchPage && !isPreviewPage) {
    let triggered = triggerApisForResdexSearchPage();
    if (triggered) return;
    // Retry when results load (same as Working_extension)
    let retryCount = 0;
    const maxRetries = 15;
    const retryInterval = 500;
    const checkAndTrigger = () => {
      retryCount++;
      const resultsLoaded = areSearchResultsLoaded();
      const currentState = extractSearchState(window.location.href);
      const stateChanged = hasSearchStateChanged(currentState, resdexLastSearchState);
      if (resultsLoaded && (stateChanged || resdexLastSearchState === null)) {
        resdexLastSearchState = currentState;
        triggerResdexVerifiedIdsAndCanScrape();
      } else if (retryCount < maxRetries) {
        setTimeout(checkAndTrigger, retryInterval);
      }
    };
    setTimeout(checkAndTrigger, 300);
  }
}

function setupResdexUrlMonitoring() {
  window.addEventListener("popstate", () => setTimeout(handleResdexUrlChange, 100));

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(history, args);
    setTimeout(handleResdexUrlChange, 100);
  };
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(history, args);
    setTimeout(handleResdexUrlChange, 100);
  };

  window.addEventListener("locationchange", () => setTimeout(handleResdexUrlChange, 100));

  const urlPollInterval = setInterval(() => {
    if (window.location.hostname.toLowerCase() !== "resdex.naukri.com") return;
    if (window.location.href !== resdexCurrentUrl) handleResdexUrlChange();
  }, 500);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (!isResdexSearchPage() || isResdexPreviewPage()) return;
    resdexCurrentUrl = window.location.href;
    resdexLastSearchState = extractSearchState(window.location.href);
    triggerResdexCanScrapeCheck("visibility");
    setTimeout(() => triggerResdexVerifiedIdsAndCanScrape(), 500);
  });
}

function initResdexSearchHandling() {
  if ((window.location.hostname || "").toLowerCase() !== "resdex.naukri.com") return;
  if (isResdexSearchPage() && !isResdexPreviewPage()) {
    resdexLastSearchState = extractSearchState(window.location.href);
    triggerResdexVerifiedIdsAndCanScrape();
  }
  setupResdexUrlMonitoring();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    triggerResdexCanScrapeCheck("domcontentloaded");
    initResdexSearchHandling();
  });
} else {
  triggerResdexCanScrapeCheck("init");
  initResdexSearchHandling();
}

// Listen messages from page
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.source === "API_INTERCEPTOR") {
    // If not logged in, do not do anything.
    if (!cachedAuthToken) return;
    console.log("📨 Content script received message:", event.data.url);
    console.log("📦 Message data:", event.data);
    
    try {
      chrome.runtime.sendMessage(event.data, (response) => {
        console.log("✅ Message sent to background, response:", response);
      });
    } catch (e) {
      console.log("❌ Error sending message to background:", e);
    }

    // After intercept activity on Resdex, re-check rate limit (cached in background).
    triggerResdexCanScrapeCheck("after_intercept");
  }
});

// --------------------------------------------------------------------------------------
// NJB (Naukri) badges on /v3/search
// Ported behavior from Working_extension: addNjbBadge() based on verified-ids response.
// --------------------------------------------------------------------------------------

const WEB_APP_URL ="https://dms.eticaatest.co.in"

let lastNjbMatched = null; // [{ index, candidateId, ... }]
let applyBadgesTimer = null;

// -----------------------------
// Auth token helpers (content)
// -----------------------------
// Content scripts can't import background modules, so we read the token directly
// from extension storage. This is required to match Working_extension behavior:
// do not call verified-ids unless user is logged in.
let cachedAuthToken = undefined; // undefined = not loaded yet

function getAuthTokenFromStorage() {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.local?.get) {
        resolve(null);
        return;
      }
      chrome.storage.local.get(["authToken"], (result) => {
        const token = result?.authToken || null;
        cachedAuthToken = token;
        resolve(token);
      });
    } catch {
      resolve(null);
    }
  });
}

async function hasAuthToken() {
  if (cachedAuthToken !== undefined) return Boolean(cachedAuthToken);
  const token = await getAuthTokenFromStorage();
  return Boolean(token);
}

function postAuthStateToPage(loggedIn) {
  try {
    window.postMessage({ source: "EXT_AUTH_STATE", loggedIn: Boolean(loggedIn) }, "*");
  } catch {
    // ignore
  }
}

let injectAttempted = false;
async function ensureInjectJsIfLoggedIn() {
  const host = (window.location.hostname || "").toLowerCase();
  if (!host.includes("naukri.com")) return;
  if (injectAttempted) return;

  const ok = await hasAuthToken();
  if (!ok) return;

  injectAttempted = true;
  postAuthStateToPage(true);

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("nexusPage.js");
  script.onload = () => {
    console.log("✅ nexusPage.js loaded and removed from DOM");
    // nexusPage.js might load after our first auth-state post; send again.
    postAuthStateToPage(true);
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// Initial auth load + conditional injection.
getAuthTokenFromStorage().then((token) => {
  postAuthStateToPage(Boolean(token));
  ensureInjectJsIfLoggedIn();
});

try {
  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes?.authToken) return;
      cachedAuthToken = changes.authToken.newValue || null;
      postAuthStateToPage(Boolean(cachedAuthToken));
      // If user just logged in, inject on existing page without reload.
      if (cachedAuthToken) ensureInjectJsIfLoggedIn();
    });
  }
} catch {
  // ignore
}

function isNjbSearchPage() {
  const host = (window.location.hostname || "").toLowerCase();
  const path = (window.location.pathname || "").toLowerCase();
  return host.includes("naukri.com") && (path === "/v3/search" || path.includes("/v3/search"));
}

function getCandidateCards() {
  return Array.from(document.querySelectorAll(".flex-row.tuple-top") || []);
}

function ensurePulseAnimationStyle() {
  if (document.getElementById("njb-pulse-animation")) return;
  const style = document.createElement("style");
  style.id = "njb-pulse-animation";
  style.textContent = `
    @keyframes pulse {
      0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(127, 86, 217, 0.6); }
      50% { transform: scale(1.05); box-shadow: 0 0 0 10px rgba(127, 86, 217, 0); }
      100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(127, 86, 217, 0); }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function addNjbBadgeToCard(card, candidateId) {
  if (!card) return;

  // Prefer to place the badge near the candidate name/headline (same as Working_extension).
  const candidateHeadline = card.querySelector(".candidate-headline");
  const badgeContainer = candidateHeadline || card.querySelector(".right-section") || card;

  if (!badgeContainer) return;
  if (badgeContainer.querySelector(".njb-matched-badge")) return;

  if (candidateHeadline) {
    badgeContainer.style.display = "inline-flex";
    badgeContainer.style.alignItems = "center";
  } else {
    const computed = window.getComputedStyle(badgeContainer);
    if (computed.position === "static" || !computed.position) {
      badgeContainer.style.position = "relative";
    }
  }

  ensurePulseAnimationStyle();

  const badge = document.createElement("div");
  badge.className = "njb-matched-badge";
  badge.textContent = "✓";
  badge.title = "Already in database - Click to view details";
  badge.style.cssText = `
    margin-left: 8px;
    width: 22px;
    height: 22px;
    background-color: #7f56d9;
    border-radius: 50%;
    color: white;
    font-size: 13px;
    font-weight: bold;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    animation: pulse 1.8s infinite;
  `;

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (candidateId) {
      const candidateUrl = `${WEB_APP_URL}/candidate-management/candidate-details/${candidateId}`;
      window.open(candidateUrl, "_blank");
    } else {
      alert("Candidate ID not available");
    }
  });

  badgeContainer.appendChild(badge);
}

function isNjbPreviewPage() {
  const host = (window.location.hostname || "").toLowerCase();
  const path = (window.location.pathname || "").toLowerCase();
  if (!host.includes("naukri.com")) return false;
  return path.includes("/preview") || path.includes("/profile");
}

function isNhHiringDetailsPage() {
  const host = (window.location.hostname || "").toLowerCase();
  if (host !== "hiring.naukri.com") return false;
  const path = window.location.pathname || "";
  return /\/hiring\/[^/]+\/apply\/[^/?#]+/i.test(path);
}

function addNhBadgeToHiringDetails(candidateId) {
  if (!isNhHiringDetailsPage()) return;
  if (!candidateId) return;

  if (document.querySelector(".nh-matched-badge")) return;

  ensurePulseAnimationStyle();

  const container = document.querySelector(".candidateDetailsHeading");
  if (!container) return;

  // make sure parent can hold absolute child
  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }

  const badge = document.createElement("div");
  badge.className = "nh-matched-badge";
  badge.textContent = "✓";
  badge.title = "Already in database - Click to view details";

  badge.style.cssText = `
    position: absolute;
    top: -6px;
    right: -6px;
    width: 22px;
    height: 22px;
    background-color: #7f56d9;
    border-radius: 50%;
    color: white;
    font-size: 13px;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 10;
    animation: pulse 1.8s infinite;
  `;

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const candidateUrl = `${WEB_APP_URL}/candidate-management/candidate-details/${candidateId}`;
    window.open(candidateUrl, "_blank");
  });

  container.appendChild(badge);
}

function addNjbBadgeToPreview(candidateId) {
  if (!isNjbPreviewPage()) return;
  if (!candidateId) return;

  // Match Working_extension placement: absolute badge on the main preview container.
  const container =
    document.querySelector("._8vcVb") ||
    document.querySelector(".profile-summary") ||
    document.body;

  if (!container) return;
  if (container.querySelector(".njb-matched-badge")) return;

  // Ensure container is positioned
  const computedStyle = window.getComputedStyle(container);
  if (computedStyle.position === "static" || !computedStyle.position) {
    container.style.position = "relative";
  }

  ensurePulseAnimationStyle();

  const badge = document.createElement("div");
  badge.className = "njb-matched-badge";
  badge.textContent = "✓";
  badge.title = "Already in database - Click to view details";
  badge.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    width: 30px;
    height: 30px;
    background-color: #7f56d9;
    border-radius: 50%;
    color: white;
    font-weight: bold;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: pointer;
    box-shadow: 0 4px 10px rgba(0,0,0,0.15);
    animation: pulse 1.8s infinite;
  `;

  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const candidateUrl = `${WEB_APP_URL}/candidate-management/candidate-details/${candidateId}`;
    window.open(candidateUrl, "_blank");
  });

  container.appendChild(badge);
}

function applyNjbBadgesNow() {
  if (!isNjbSearchPage()) return;
  if (!Array.isArray(lastNjbMatched) || lastNjbMatched.length === 0) return;

  const cards = getCandidateCards();
  if (!cards.length) return;

  for (const m of lastNjbMatched) {
    const idx = typeof m?.index === "number" ? m.index : parseInt(String(m?.index || ""), 10);
    if (!Number.isFinite(idx)) continue;
    const card = cards[idx];
    if (!card) continue;
    addNjbBadgeToCard(card, m?.candidateId || "");
  }
}

function scheduleApplyNjbBadges(delayMs = 300) {
  if (applyBadgesTimer) clearTimeout(applyBadgesTimer);
  applyBadgesTimer = setTimeout(() => {
    applyBadgesTimer = null;
    applyNjbBadgesNow();
  }, delayMs);
}

// We DO NOT call verified-ids from the content script.
// Verified-ids must be called only from the Interceptor path in the background
// (payload includes `ids` + `jobBoardFrontPageDetails`).
// Content script only paints badges based on messages from the background.

// Receive verified-ids matches from background (already filtered to match===true).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "NJB_VERIFIED_IDS_MATCHES") return;
  if (!isNjbSearchPage()) return;

  const matched = Array.isArray(message.matched) ? message.matched : [];
  lastNjbMatched = matched;
  scheduleApplyNjbBadges(200);
});

// Preview page tick after intercept+save (candidateId available)
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "NJB_PREVIEW_BADGE") return;
  addNjbBadgeToPreview(message?.candidateId ? String(message.candidateId) : "");
});

// Hiring details page tick after intercept+save (candidateId available)
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "NH_DETAIL_BADGE") return;
  addNhBadgeToHiringDetails(message?.candidateId ? String(message.candidateId) : "");
});

// Refresh badges after candidate is scraped/saved (background sends this).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "NJB_REFRESH_BADGES") return;
  if (!isNjbSearchPage()) return;
  // No API call here. Just re-apply any latest match set.
  scheduleApplyNjbBadges(200);
});

// Observe DOM changes on /v3/search so badges stay when results paginate/refresh.
(() => {
  const observer = new MutationObserver(() => {
    if (!isNjbSearchPage()) return;
    if (!lastNjbMatched) return;
    scheduleApplyNjbBadges(200);
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
})();

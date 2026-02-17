// Inject interceptor only on Naukri pages (prevents interfering with Shine scripts).
(() => {
  const host = (window.location.hostname || "").toLowerCase();
  if (!host.includes("naukri.com")) return;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject.js");
  script.onload = () => {
    console.log("✅ inject.js loaded and removed from DOM");
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
})();

console.log("🟢 Content script initialized");

// Listen messages from page
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.source === "API_INTERCEPTOR") {
    console.log("📨 Content script received message:", event.data.url);
    console.log("📦 Message data:", event.data);
    
    try {
      chrome.runtime.sendMessage(event.data, (response) => {
        console.log("✅ Message sent to background, response:", response);
      });
    } catch (e) {
      console.error("❌ Error sending message to background:", e);
    }
  }
});

// --------------------------------------------------------------------------------------
// NJB (Naukri) badges on /v3/search
// Ported behavior from Working_extension: addNjbBadge() based on verified-ids response.
// --------------------------------------------------------------------------------------

const WEB_APP_URL = "https://dms.eticaa.com";
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

try {
  if (chrome?.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (!changes?.authToken) return;
      cachedAuthToken = changes.authToken.newValue || null;
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



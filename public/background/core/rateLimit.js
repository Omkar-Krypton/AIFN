/* global chrome */
import { ETICA_EXT_URL } from "../../config/constants.js";
import { getStoredAuth } from "./auth.js";

// Cache for rate limit checks to prevent multiple API calls
// Structure: { [jobBoard]: { result: {...}, timestamp: number, inProgress: Promise } }
const rateLimitCache = {};
const RATE_LIMIT_CACHE_MS = 30000; // Cache for 30 seconds

export async function checkCanScrape(jobBoard) {
  try {
    const { storedToken } = await getStoredAuth();

    if (!storedToken) {
      // If user is not logged in, allow scraping without rate limit check
      return { canScrape: true, reason: "NO_AUTH_TOKEN" };
    }

    // Extract userId from token
    let userId = null;
    try {
      const payload = JSON.parse(atob(storedToken.split(".")[1]));
      userId = payload._id || payload.id;
    } catch (e) {
      console.warn("[Rate Limit] Could not decode token to get user ID:", e);
      return { canScrape: false, reason: "INVALID_TOKEN" };
    }

    if (!userId) {
      console.warn("[Rate Limit] User ID not found in token");
      return { canScrape: false, reason: "NO_USER_ID" };
    }

    // Get user data to extract customerId
    let customerId = null;
    try {
      const userResponse = await fetch(`${ETICA_EXT_URL}/profile/me`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
        },
      });

      if (userResponse.ok) {
        const userData = await userResponse.json().catch(() => ({}));
        customerId = userData?.data?.data?.customerId || userData?.data?.customerId || null;
      }
    } catch (error) {
      console.warn("[Rate Limit] Failed to fetch user data:", error);
    }

    if (!customerId) {
      console.warn("[Rate Limit] Customer ID not found");
      return { canScrape: false, reason: "NO_CUSTOMER_ID" };
    }

    // Use job board identifier directly: "NJ" for Naukri, "SJ" for Shine
    const jobBoardParam = jobBoard;

    const apiUrl = `${ETICA_EXT_URL}/scraping-limits/can-scrape?customerId=${customerId}&userId=${userId}&jobBoard=${jobBoardParam}`;
    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${storedToken}`,
      },
    });

    if (!response.ok) {
      // If API fails, allow scraping to avoid blocking users due to API issues
      return { canScrape: true, reason: "API_ERROR" };
    }

    const data = await response.json().catch(() => ({}));

    return {
      canScrape: data.canScrape !== false,
      reason: data.reason || null,
      maxLimit: data.maxLimit,
      used: data.used,
      remaining: data.remaining,
      scope: data.scope,
      period: data.period,
    };
  } catch (error) {
    console.error("[Rate Limit] Error checking can-scrape:", error);
    // If there's an error, allow scraping to avoid blocking users due to network issues
    return { canScrape: true, reason: "ERROR" };
  }
}

function freezeTabForRateLimit(tabId, limitInfo) {
  if (!tabId) return;

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

  const message = `${reasonText} ${periodText ? `(${periodText})` : ""}. You have used ${
    limitInfo.used || 0
  } of ${limitInfo.maxLimit || 0} allowed scrapes. Please wait until the limit resets to continue scraping.`;

  chrome.tabs
    .sendMessage(tabId, {
      type: "FREEZE_PAGE",
      message: message,
    })
    .catch(() => {
      // ignore tab message failures (tab may not have content script)
    });
}

async function getCachedOrFetchRateLimit(jobBoard) {
  const now = Date.now();
  const cacheKey = jobBoard || "default";
  const cached = rateLimitCache[cacheKey];

  if (cached && cached.result && now - cached.timestamp < RATE_LIMIT_CACHE_MS) {
    return cached.result;
  }

  if (cached && cached.inProgress) {
    return await cached.inProgress;
  }

  const fetchPromise = checkCanScrape(jobBoard);
  rateLimitCache[cacheKey] = {
    inProgress: fetchPromise,
    timestamp: now,
  };

  try {
    const result = await fetchPromise;
    rateLimitCache[cacheKey] = {
      result: result,
      timestamp: now,
      inProgress: null,
    };
    return result;
  } catch (error) {
    if (rateLimitCache[cacheKey]) {
      rateLimitCache[cacheKey].inProgress = null;
    }
    throw error;
  }
}

export function handleCheckCanScrape(message, sender, sendResponse) {
  (async () => {
    try {
      const skipHosts = ["recruit.naukri.com", "hiring.naukri.com"];

      const shineHost = "recruiter.shine.com";
      const shineAllowedPaths = ["/recruiter/search/advanced/", "/search/profile/", "/job/", "/dashboard/opens/"];

      const resdexHost = "resdex.naukri.com";
      const resdexAllowedPaths = ["/v3/search", "/v3/preview"];

      const tabUrl = sender.tab?.url || sender.url || null;
      if (tabUrl) {
        try {
          const url = new URL(tabUrl);

          if (skipHosts.includes(url.hostname)) {
            sendResponse({ canScrape: true, reason: "SKIP_HOST", maxLimit: 0, used: 0, remaining: 0 });
            return;
          }

          if (url.hostname === shineHost) {
            const isAllowed = shineAllowedPaths.some((p) => url.pathname.startsWith(p));
            if (!isAllowed) {
              sendResponse({ canScrape: true, reason: "SKIP_SHINE_PATH", maxLimit: 0, used: 0, remaining: 0 });
              return;
            }
          }

          if (url.hostname === resdexHost) {
            const isAllowed = resdexAllowedPaths.some((p) => url.pathname.startsWith(p));
            if (!isAllowed) {
              sendResponse({ canScrape: true, reason: "SKIP_RESTDEX_PATH", maxLimit: 0, used: 0, remaining: 0 });
              return;
            }
          }
        } catch {
          // ignore URL parse errors
        }
      }

      const { jobBoard } = message;
      const result = await getCachedOrFetchRateLimit(jobBoard);

      if (!result.canScrape && result.reason !== "NO_AUTH_TOKEN" && sender.tab?.id) {
        freezeTabForRateLimit(sender.tab.id, result);
      }

      sendResponse(result);
    } catch (error) {
      console.error("[Rate Limit] Error in handleCheckCanScrape:", error);
      sendResponse({ canScrape: false, reason: "API_ERROR", maxLimit: 0, used: 0, remaining: 0 });
    }
  })();

  return true;
}


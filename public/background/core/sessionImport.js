/* global chrome */
import {
  validateSessionData,
  getPlatformInfo,
  getAllCookies,
  getLocalStorageData,
  getSessionStorageData,
  setLocalStorage,
  setSessionStorage,
  storeImportedSessionInExtension,
  clearBrowserCacheBeforeImport,
} from "./session.js";
import {
  validateCrossPlatformCookies,
  validateNaukriSession,
  validateShineSession,
} from "./cookies.js";

export async function handleImportSession(sessionData, sendResponse) {
  try {
    // Clear browser cache before importing session (for both njb and sjb)
    let finalUrl = sessionData.url || "https://resdex.naukri.com";
    try {
      const url = new URL(finalUrl);
      if (url.hostname.includes("hiring.naukri.com")) {
        finalUrl = url.toString();
      } else if (url.hostname.includes("naukri.com")) {
        url.hostname = "resdex.naukri.com";
        finalUrl = url.toString();
      } else if (url.hostname.includes("shine.com")) {
        finalUrl = url.toString();
      }
    } catch {
      finalUrl = "https://resdex.naukri.com";
    }

    await clearBrowserCacheBeforeImport(finalUrl);

    const cleanedSessionData = validateSessionData(sessionData);

    const data = cleanedSessionData.data;
    const localStorageData = data.localStorage || {};
    const sessionStorageData = data.sessionStorage || {};
    const cookies = data.cookies;

    const platformInfo = await getPlatformInfo();

    // Prepare domain for cookie acceptance.
    const tempTab = await chrome.tabs.create({ url: finalUrl, active: false });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Set cookies
    let successCount = 0;
    let failureCount = 0;
    for (const cookie of cookies) {
      try {
        let domain = cookie.domain.startsWith(".") ? cookie.domain : `.${cookie.domain}`;
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
        if (["Strict", "Lax", "None"].includes(cookie.sameSite)) {
          cookieDetails.sameSite = cookie.sameSite;
        }
        await chrome.cookies.set(cookieDetails);
        successCount++;
      } catch (err) {
        failureCount++;
        console.warn(`Failed to set cookie ${cookie.name}:`, err);
      }
    }

    await chrome.tabs.remove(tempTab.id);
    const tab = await chrome.tabs.create({ url: finalUrl, active: false });

    // Validate cookies
    await validateCrossPlatformCookies(finalUrl, cookies);
    if (finalUrl.includes("naukri.com")) {
      await validateNaukriSession(finalUrl, cookies);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } else if (finalUrl.includes("shine.com")) {
      await validateShineSession(finalUrl, cookies);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

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

    // Set storage
    await setLocalStorage(tab, localStorageData);
    await setSessionStorage(tab, sessionStorageData);

    // Reload final tab
    await chrome.tabs.reload(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 3000));
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

    sendResponse({
      success: true,
      platform: platformInfo.os,
      cookiesSet: successCount,
      cookiesFailed: failureCount,
    });
  } catch (error) {
    console.error("Import session error:", error);
    sendResponse({
      success: false,
      error: "Failed to import session: " + error.message,
    });
  }
}

export async function handleExportSession(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || !tab.url) {
      sendResponse({
        status: 0,
        message: "No active tab or URL found.",
      });
      return;
    }

    const url = new URL(tab.url);

    const cookies = await getAllCookies(url);
    const localStorage = await getLocalStorageData();
    const sessionStorage = await getSessionStorageData();

    const safeLocalStorage = localStorage || {};
    const safeSessionStorage = sessionStorage || {};

    const data = {
      domain: url.hostname,
      url: tab.url,
      cookies: cookies,
      timestamp: new Date().toISOString(),
      localStorage: safeLocalStorage,
      sessionStorage: safeSessionStorage,
    };

    sendResponse({
      status: 1,
      data,
    });
  } catch (error) {
    console.error("Share session error:", error);
    sendResponse({
      status: 0,
      message: "Failed to share session: " + error.message,
    });
  }
}

export async function handleLogoutAndClearData(sendResponse) {
  try {
    const domainsToClean = [
      // Naukri domains
      { domain: ".naukri.com", url: "https://resdex.naukri.com" },
      { domain: "resdex.naukri.com", url: "https://resdex.naukri.com" },
      { domain: "www.naukri.com", url: "https://www.naukri.com" },
      { domain: "hiring.naukri.com", url: "https://hiring.naukri.com" },
      // Shine domains
      { domain: ".shine.com", url: "https://recruiter.shine.com" },
      { domain: "recruiter.shine.com", url: "https://recruiter.shine.com" },
      { domain: "www.shine.com", url: "https://www.shine.com" },
    ];

    let totalCookiesRemoved = 0;

    for (const { domain } of domainsToClean) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          try {
            const urlToRemove = `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
            await chrome.cookies.remove({
              url: urlToRemove,
              name: cookie.name,
            });
            totalCookiesRemoved++;
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    // Clear extension storage related to sessions + auth
    const storageKeys = [
      "importSessions",
      "authToken",
      "lastNjbProfile",
      "lastSjbProfile",
      "naukriProfileId",
      "naukriProfileScraped",
      "cvHtmlScraped",
    ];
    await chrome.storage.local.remove(storageKeys);

    // Clear domain-specific keys from storage (best-effort)
    const allStorage = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
    const keysToRemove = [];
    for (const key in allStorage) {
      if (key.startsWith("naukri_") || key.startsWith("shine_") || key.includes("uniqueId")) {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      await chrome.storage.local.remove(keysToRemove);
    }

    sendResponse({ success: true, cookiesRemoved: totalCookiesRemoved });
  } catch (err) {
    console.error("Logout cleanup error:", err);
    sendResponse({ success: false, error: err.message });
  }
}

export async function getDomain(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || !tab.url) {
      throw new Error("No active tab or URL found.");
    }

    const url = new URL(tab.url);

    sendResponse({
      success: true,
      domain: url.hostname,
    });
  } catch (error) {
    sendResponse({
      success: false,
      error: "Failed to get domain: " + error.message,
    });
  }
}


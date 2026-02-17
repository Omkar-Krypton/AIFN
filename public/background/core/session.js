export function validateSessionData(sessionData) {
  if (!sessionData || !sessionData.data) {
    throw new Error("Invalid session data structure");
  }

  // Derive hostname from session URL for cookies missing domain
  let urlHostname = null;
  try {
    if (sessionData.url) {
      urlHostname = new URL(sessionData.url).hostname || null;
    }
  } catch {
    urlHostname = null;
  }

  // First prepare cookies by filling missing domains from URL when possible
  const preparedCookies = (sessionData.data.cookies || []).map((cookie) => {
    const prepared = { ...cookie };
    if (!prepared.domain && urlHostname) {
      prepared.domain = urlHostname;
    }
    return prepared;
  });

  const cleanedCookies = preparedCookies
    .filter((cookie) => {
      return cookie && cookie.name && cookie.value !== undefined && cookie.domain;
    })
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
    if (cleanedLocalStorage[key] === null || cleanedLocalStorage[key] === undefined) {
      delete cleanedLocalStorage[key];
    }
  });

  Object.keys(cleanedSessionStorage).forEach((key) => {
    if (cleanedSessionStorage[key] === null || cleanedSessionStorage[key] === undefined) {
      delete cleanedSessionStorage[key];
    }
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

export async function getPlatformInfo() {
  return new Promise((resolve) => {
    chrome.runtime.getPlatformInfo((platformInfo) => {
      const os = platformInfo.os;
      const arch = platformInfo.arch;

      const isWindows = os === "win";
      const isMac = os === "mac";
      const isLinux = os === "linux" || os === "openbsd" || os === "cros";

      resolve({
        os,
        arch,
        isWindows,
        isMac,
        isLinux,
        platformString: `${os}-${arch}`,
      });
    });
  });
}

export function extractDomain(url) {
  return new URL(url).hostname;
}

export async function getAllCookies(urlObject) {
  const cookies = await chrome.cookies.getAll({ url: urlObject.href });
  return cookies;
}

export async function getLocalStorageData() {
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
      (results) => {
        if (results && results[0] && results[0].result) {
          resolve(results[0].result);
        } else {
          resolve({});
        }
      }
    );
  });
}

export async function getSessionStorageData() {
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
      (results) => {
        if (results && results[0] && results[0].result) {
          resolve(results[0].result);
        } else {
          resolve({});
        }
      }
    );
  });
}

export async function setLocalStorage(tab, data) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: (localStorageData) => {
        for (const key in localStorageData) {
          if (localStorageData[key] !== null && localStorageData[key] !== undefined) {
            localStorage.setItem(key, localStorageData[key]);
          }
        }
      },
      args: [data],
    });
  } catch (error) {
    console.error("Failed to set localStorage:", error);
  }
}

export async function setSessionStorage(tab, data) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: (sessionStorageData) => {
        for (const key in sessionStorageData) {
          if (sessionStorageData[key] !== null && sessionStorageData[key] !== undefined) {
            sessionStorage.setItem(key, sessionStorageData[key]);
          }
        }
      },
      args: [data],
    });
  } catch (error) {
    console.error("Failed to set sessionStorage:", error);
  }
}

export async function storeImportedSessionInExtension(additionalInfo) {
  const result = await new Promise((resolve) => chrome.storage.local.get("importSessions", resolve));
  const importSessions = result?.importSessions || [];

  const existingIndex = importSessions.findIndex((session) => session.domain === additionalInfo.domain);

  if (existingIndex !== -1) {
    importSessions[existingIndex] = additionalInfo;
  } else {
    importSessions.push(additionalInfo);
  }

  await chrome.storage.local.set({ importSessions });
}

export async function clearDomainData(url) {
  const origin = new URL(url).origin;

  await new Promise((resolve) => {
    chrome.browsingData.remove(
      {
        origins: [origin],
      },
      {
        cache: true,
        cookies: true,
        fileSystems: true,
        indexedDB: true,
        localStorage: true,
        pluginData: true,
        serviceWorkers: true,
      },
      () => resolve()
    );
  });
}

/**
 * Clear browser cache before importing session.
 * Clears cookies, localStorage, sessionStorage, and extension storage for the domain.
 * Works for both Naukri (njb) and Shine (sjb).
 */
export async function clearBrowserCacheBeforeImport(url) {
  try {
    let finalUrl = url;
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname.includes("naukri.com")) {
        urlObj.hostname = "resdex.naukri.com";
        finalUrl = urlObj.toString();
      } else if (urlObj.hostname.includes("shine.com")) {
        finalUrl = urlObj.toString();
      }
    } catch {
      // Invalid URL, use as-is
    }

    const origin = new URL(finalUrl).origin;
    const hostname = new URL(finalUrl).hostname;

    // 1. Clear browsing data (cookies, cache, localStorage, etc.)
    await new Promise((resolve) => {
      chrome.browsingData.remove(
        {
          origins: [origin],
        },
        {
          cache: true,
          cookies: true,
          fileSystems: true,
          indexedDB: true,
          localStorage: true,
          pluginData: true,
          serviceWorkers: true,
        },
        () => resolve()
      );
    });

    // 2. Clear all cookies for the domain (including subdomains)
    const domainPatterns = [];
    if (hostname.includes("naukri.com")) {
      domainPatterns.push(".naukri.com", "resdex.naukri.com", "www.naukri.com");
    } else if (hostname.includes("shine.com")) {
      domainPatterns.push(".shine.com", "www.shine.com", "recruiter.shine.com");
    }

    for (const domain of domainPatterns) {
      try {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          try {
            const urlToRemove = `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
            await chrome.cookies.remove({
              url: urlToRemove,
              name: cookie.name,
            });
          } catch {
            // ignore individual cookie failures
          }
        }
      } catch {
        // ignore domain failures
      }
    }

    // 3. Clear chrome.storage.local entries related to the domain
    try {
      const storageKeys = [
        "lastNjbProfile",
        "lastSjbProfile",
        "naukriProfileId",
        "naukriProfileScraped",
        "cvHtmlScraped",
        "importSessions",
      ];

      const allStorage = await new Promise((resolve) => chrome.storage.local.get(null, resolve));
      const keysToRemove = [];

      for (const key of storageKeys) {
        if (Object.prototype.hasOwnProperty.call(allStorage, key)) {
          keysToRemove.push(key);
        }
      }

      for (const key in allStorage) {
        if (key.startsWith("naukri_") && hostname.includes("naukri.com")) {
          keysToRemove.push(key);
        } else if (key.startsWith("shine_") && hostname.includes("shine.com")) {
          keysToRemove.push(key);
        } else if (key.includes("uniqueId") && (hostname.includes("naukri.com") || hostname.includes("shine.com"))) {
          keysToRemove.push(key);
        }
      }

      if (keysToRemove.length > 0) {
        await chrome.storage.local.remove(keysToRemove);
      }
    } catch (err) {
      console.warn("[Cache Clear] Error clearing chrome.storage.local:", err);
    }

    // 4. Clear localStorage and sessionStorage via script injection in open tabs (best-effort)
    try {
      const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` });
      for (const tab of tabs) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: () => {
              try {
                localStorage.clear();
                sessionStorage.clear();
              } catch {}
            },
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  } catch (error) {
    console.error("[Cache Clear] Error clearing cache:", error);
  }
}


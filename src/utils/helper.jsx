/* global chrome */
import { disconnectSocket } from "../service/socket.service";

export const getStoredAuth = async () => {
  let storedToken = null;
  if (chrome?.storage?.local) {
    storedToken = await new Promise((resolve) => {
      chrome.storage.local.get(["authToken"], (result) => {
        resolve(result.authToken);
      });
    });
  } else {
    storedToken = localStorage.getItem("authToken");
  }
  return { storedToken };
};

export const setStoredAuth = async (authData) => {
  if (chrome?.storage?.local) {
    await new Promise((resolve) => {
      chrome.storage.local.set(authData, resolve);
    });
  } else {
    localStorage.setItem("authToken", authData.authToken);
  }
  return true;
};

export const getAllowedDomains = () => {
  // Allowed job boards for session share/import via popup.
  return [
    "resdex.naukri.com",
    "www.resdex.naukri.com",
    "hiring.naukri.com",
    "www.hiring.naukri.com",
    "www.naukri.com",
    "naukri.com",
    "shine.com",
    "www.shine.com",
    "recruiter.shine.com",
    "www.recruiter.shine.com",
  ];
};

export const getCurrentTabDomain = async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.url) return null;
    const url = new URL(tab.url);
    return url.hostname;
  } catch (error) {
    console.log("Get domain error:", error);
    return null;
  }
};

export const isNaukriDomain = (domain) => {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return (
    d === "naukri.com" ||
    d === "www.naukri.com" ||
    d === "resdex.naukri.com" ||
    d === "www.resdex.naukri.com" ||
    d === "hiring.naukri.com" ||
    d === "www.hiring.naukri.com"
  );
};

// Alias for isNaukriDomain (NJB = Naukri Job Board)
export const isNJBDomain = (domain) => isNaukriDomain(domain);

export const isShineDomain = (domain) => {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return (
    d === "shine.com" ||
    d === "www.shine.com" ||
    d === "recruiter.shine.com" ||
    d === "www.recruiter.shine.com"
  );
};

// Alias for isShineDomain (SJB = Shine Job Board)
export const isSJBDomain = (domain) => isShineDomain(domain);

export const logOut = async () => {
  // Soft logout: clears only extension auth/session state.
  console.log("[DEBUG] logOut() called (soft)");

  try {
    disconnectSocket();
  } catch (e) {
    console.warn("[DEBUG] Socket disconnect failed", e);
  }

  localStorage.removeItem("authToken");
  localStorage.removeItem("forceLogoutMessage");
  sessionStorage.clear();

  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    try {
      await new Promise((resolve) => {
        chrome.storage.local.remove(["authToken"], resolve);
      });
    } catch (e) {
      console.warn("[DEBUG] Chrome storage removal failed", e);
    }
  }

  return true;
};

export const logOutAndClearCookies = async () => {
  // Hard logout: also clears job-board cookies via background script.
  await logOut();

  if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
    await new Promise((resolve) => {
      const timeoutId = setTimeout(resolve, 500);
      chrome.runtime.sendMessage({ action: "logout" }, () => {
        clearTimeout(timeoutId);
        resolve();
      });
    });
  }

  return true;
};


/* global chrome */

// Helper function to safely send messages to background script
function sendMessageToBackground(message) {
  try {
    if (chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(message, () => {
        // ignore response/errors here (caller can use sendMessageSafely)
      });
    }
  } catch {
    // ignore
  }
}

// Add connection check function to ensure background script is ready
function isBackgroundScriptReady() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "PING" }, () => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Safe message sending with retry logic
async function sendMessageSafely(message, maxRetries = 3) {
  let attempts = 0;

  while (attempts < maxRetries) {
    // eslint-disable-next-line no-await-in-loop
    if (await isBackgroundScriptReady()) {
      try {
        return await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (response) {
              resolve(response);
            } else {
              resolve(null);
            }
          });
        });
      } catch (error) {
        attempts++;
        if (attempts < maxRetries) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } else {
          throw error;
        }
      }
    } else {
      attempts++;
      if (attempts < maxRetries) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw new Error("[Content] Failed to send message after all retries");
}

window.sendMessageToBackground = sendMessageToBackground;
window.isBackgroundScriptReady = isBackgroundScriptReady;
window.sendMessageSafely = sendMessageSafely;

// -----------------------------
// Auth token helpers (content)
// -----------------------------
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
  if (cachedAuthToken !== undefined) {
    return Boolean(cachedAuthToken);
  }
  const token = await getAuthTokenFromStorage();
  return Boolean(token);
}

// Keep cache updated when user logs in/out.
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

window.getAuthTokenFromStorage = getAuthTokenFromStorage;
window.hasAuthToken = hasAuthToken;


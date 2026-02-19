// Keep auth storage helpers in background/core (matches Working_extension structure).
export const getStoredAuth = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken"], (result) => {
      resolve({
        storedToken: result?.authToken || null,
      });
    });
  });
};


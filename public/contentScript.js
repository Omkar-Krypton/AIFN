// Inject script into page context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
script.onload = () => {
  console.log("✅ inject.js loaded and removed from DOM");
  script.remove();
};
(document.head || document.documentElement).appendChild(script);

console.log("🟢 Content script initialized");

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function arrayBufferToBase64(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  } catch (e) {
    console.error("❌ Failed converting ArrayBuffer to base64", e);
    return "";
  }
}

function downloadResumeIntoMemory(resumeUrl, pathname) {
  return new Promise((resolve, reject) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = true;

      xhr.onload = () => {
        try {
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(`resume download failed (${xhr.status})`));
            return;
          }
          const base64 = arrayBufferToBase64(xhr.response);
          if (!base64) {
            reject(new Error("empty resume buffer"));
            return;
          }
          resolve(base64);
        } catch (e) {
          reject(e);
        }
      };

      xhr.onerror = () => reject(new Error("resume download network error"));
      xhr.open("GET", resumeUrl, true);
      xhr.send();
    } catch (e) {
      reject(e);
    }
  });
}

function schedulePreviewFlowIfNeeded(interceptMsg) {
  try {
    const url = interceptMsg?.url || "";
    const pathname = interceptMsg?.pathname || window.location.pathname || "";

    const isPreview = typeof pathname === "string" && pathname.includes("preview");
    const isJsProfile =
      typeof url === "string" && url.includes("recruiter-js-profile-services");

    if (!isPreview || !isJsProfile) return;

    // Prevent multiple schedules on the same page load.
    if (window.__aifn_preview_flow_scheduled) return;
    window.__aifn_preview_flow_scheduled = true;

    // Phone click: randomized 1-2s after jsprofile.
    let delayPhoneMs = randInt(1000, 2000);

    // Resume fetch: randomized 2-6s after phone click (as requested).
    let delayResumeMs = randInt(2000, 6000);

    // Avoid repeating the exact same timing pair back-to-back (best-effort).
    const lastSig = sessionStorage.getItem("__aifn_last_timing_sig") || "";
    let sig = `${delayPhoneMs}|${delayResumeMs}`;
    let guard = 0;
    while (sig === lastSig && guard < 10) {
      delayPhoneMs = randInt(1000, 2000);
      delayResumeMs = randInt(2000, 6000);
      sig = `${delayPhoneMs}|${delayResumeMs}`;
      guard += 1;
    }
    sessionStorage.setItem("__aifn_last_timing_sig", sig);

    setTimeout(() => {
      window.postMessage(
        { source: "AIFN_EXTENSION", type: "CLICK_VIEW_PHONE", pathname },
        "*"
      );
    }, delayPhoneMs);

    setTimeout(() => {
      window.postMessage(
        {
          source: "AIFN_EXTENSION",
          type: "PREPARE_RESUME_URL",
          profile: interceptMsg.data,
          jsprofileUrl: url,
          pathname,
        },
        "*"
      );
    }, delayPhoneMs + delayResumeMs);

    // After resume-url is prepared in MAIN world, do the actual request from the content script
    // so DevTools Initiator points here (not inject.js).
    const afterPrepareMs = randInt(80, 220);
    setTimeout(async () => {
      try {
        const rm = document.getElementById("rmfile");
        const resumeUrl = rm && typeof rm.value === "string" ? rm.value : "";
        if (!resumeUrl) return;

        const cvBuffer = await downloadResumeIntoMemory(resumeUrl, pathname);
        chrome.runtime.sendMessage({
          source: "API_INTERCEPTOR",
          kind: "RESUME_FETCH",
          url: resumeUrl,
          status: 200,
          data: { cvBuffer },
          pathname,
        });
      } catch (e) {
        console.error("❌ Resume download failed:", e);
      }
    }, delayPhoneMs + delayResumeMs + afterPrepareMs);
  } catch (e) {
    console.error("❌ Failed scheduling preview flow:", e);
  }
}

// Listen messages from page (inject / inject_naukri)
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.source === "API_INTERCEPTOR") {
    try {
      schedulePreviewFlowIfNeeded(event.data);
      chrome.runtime.sendMessage(event.data);
    } catch (e) {
      console.error("❌ Error sending message to background:", e);
    }
  }
});



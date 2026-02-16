(function () {
  // console.log("🚀 API Interceptor inject.js loaded");
  const isNaukriHost = /(^|\.)naukri\.com$/i.test(window.location.hostname);
  const naukriResumeState = {
    inFlight: false,
    lastSignature: "",
  };

  //this function is just for logging naukri related events.

  function logNaukri(message, data) {
    if (!isNaukriHost) return;
    if (data !== undefined) {
      console.log("[NAUKRI_RESUME_TRIGGER]", message, data);
      return;
    }
    console.log("[NAUKRI_RESUME_TRIGGER]", message);
  }
  

  function getJsProfileFromPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.jsprofile && typeof payload.jsprofile === "object") return payload.jsprofile;
    if (payload.rmsResponse?.jsprofile && typeof payload.rmsResponse.jsprofile === "object") {
      return payload.rmsResponse.jsprofile;
    }
    if (payload.data?.jsprofile && typeof payload.data.jsprofile === "object") {
      return payload.data.jsprofile;
    }
    if (payload.result?.jsprofile && typeof payload.result.jsprofile === "object") {
      return payload.result.jsprofile;
    }
    if (payload.encryptedResId && payload.doubleEncryptedUserName) {
      return payload;
    }
    return null;
  }

  function buildNaukriResumeUrl(jsprofile) {
    const gnb = window.gnb_variables || {};
    const companyId = gnb.companyId;
    const userId = gnb.userId;
    const appId = gnb.appId;

    if (!companyId || !userId) {
      logNaukri("Missing companyId or userId in gnb_variables", {
        companyId,
        userId,
      });
      return null;
    }
    if (!jsprofile?.encryptedResId || !jsprofile?.doubleEncryptedUserName) {
      logNaukri("Missing encryptedResId/doubleEncryptedUserName in jsprofile", {
        hasEncryptedResId: !!jsprofile?.encryptedResId,
        hasDoubleEncryptedUserName: !!jsprofile?.doubleEncryptedUserName,
      });
      return null;
    }

    const nowEpoch = Math.ceil(Date.now() / 1000);
    const urlObj = new URL(window.location.href);
    const searchParamStr = urlObj.searchParams.get("paramString");
    const sid = urlObj.searchParams.get("sid");

    let resumeUrl =
      "https://resdex.naukri.com/cloudgateway-resdex/recruiter-js-profile-services/v0/companies/" +
      companyId +
      "/recruiters/" +
      userId +
      "/jsprofile/download/resume?AT=" +
      nowEpoch +
      "&resId=" +
      jsprofile.encryptedResId +
      "&uname=" +
      jsprofile.doubleEncryptedUserName;

    if (searchParamStr) {
      resumeUrl += "&searchParamStr=" + encodeURIComponent(searchParamStr);
    }
    resumeUrl += sid ? "&sid=" + encodeURIComponent(sid) : "&sid=";

    return {
      resumeUrl,
      appId,
      companyId,
      userId,
      nowEpoch,
      searchParamStr,
      sid,
      signature:
        String(companyId) +
        "|" +
        String(userId) +
        "|" +
        String(jsprofile.encryptedResId) +
        "|" +
        String(searchParamStr || "") +
        "|" +
        String(sid || ""),
    };
  }

  async function triggerNaukriResumeDownloadIfPossible(payload, sourceUrl) {
    if (!isNaukriHost) return;
    if (typeof sourceUrl !== "string" || !sourceUrl.includes("recruiter-js-profile-services")) {
      return;
    }
    if (!window.location.pathname.includes("/preview")) {
      return;
    }

    const jsprofile = getJsProfileFromPayload(payload);
    if (!jsprofile) {
      logNaukri("Recruiter profile response seen but jsprofile shape not supported", {
        sourceUrl,
        topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).slice(0, 20) : [],
      });
      return;
    }

    const built = buildNaukriResumeUrl(jsprofile);
    if (!built) return;

    if (naukriResumeState.inFlight || naukriResumeState.lastSignature === built.signature) {
      logNaukri("Skipping resume download call due to inFlight/duplicate signature", {
        inFlight: naukriResumeState.inFlight,
        isDuplicate: naukriResumeState.lastSignature === built.signature,
        signature: built.signature,
      });
      return;
    }

    naukriResumeState.inFlight = true;
    logNaukri("Calling download resume API", {
      nowEpoch: built.nowEpoch,
      hasATParam: built.resumeUrl.includes("?AT="),
      sourceUrl,
      resumeUrl: built.resumeUrl,
    });

    try {
      // Use XHR (not fetch) so it matches the page's typical download flow and
      // is captured by our existing XHR resume interceptor.
      await new Promise((resolve, reject) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open("GET", built.resumeUrl, true);
        xhr.responseType = "arraybuffer";
        xhr.withCredentials = true;
        xhr.setRequestHeader("Appid", String(built.appId || ""));
        xhr.setRequestHeader("Systemid", "naukriIndia");

        xhr.onload = () => {
          const ok = xhr.status >= 200 && xhr.status < 300;
          logNaukri("Download resume API XHR completed", {
            status: xhr.status,
            ok,
            contentType: xhr.getResponseHeader("content-type") || "",
          });
          if (ok) {
            naukriResumeState.lastSignature = built.signature;
          }
          resolve();
        };
        xhr.onerror = () => {
          reject(new Error("XHR network error"));
        };
        xhr.onabort = () => {
          reject(new Error("XHR aborted"));
        };

        xhr.send();
      });
    } catch (e) {
      logNaukri("Download resume API call failed", e);
    } finally {
      naukriResumeState.inFlight = false;
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          // result is like: data:application/pdf;base64,JVBERi0x...
          const commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error("FileReader error"));
        reader.readAsDataURL(blob);
      } catch (e) {
        reject(e);
      }
    });
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

  // FETCH
  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || 'unknown';
    // console.log("🔍 Fetch intercepted BEFORE call:", url);

    const response = await originalFetch(...args);

    // console.log("🔍 Fetch intercepted AFTER call:", url, "Status:", response.status);

    try {
      const clone = response.clone();
      const ct = clone.headers.get("content-type") || "";

      // console.log("📋 Content-Type:", ct, "for URL:", url);

      const isResumeApi =
        typeof url === "string" &&
        (url.includes("/jsprofile/download/resume") || url.includes("jsprofile/download/resume"));

      // Resume API can return:
      // - raw base64 text, OR
      // - application/pdf binary (blob/arraybuffer)
      if (isResumeApi) {
        let cvBuffer = "";

        if (ct.toLowerCase().includes("application/pdf")) {
          const blob = await clone.blob();
          cvBuffer = await blobToBase64(blob);
        } else {
          // Some environments return the base64 directly as text.
          cvBuffer = await clone.text();
        }

        console.log("📄 Resume API intercepted (fetch), sending cvBuffer to background");
        window.postMessage(
          {
            source: "API_INTERCEPTOR",
            kind: "FETCH",
            url: clone.url,
            status: clone.status,
            data: { cvBuffer },
            pathname: window.location.pathname
          },
          "*"
        );
      } else if (ct.includes("application/json")) {
        const data = await clone.json();

        // console.log("📤 Posting message for:", url);
        // console.log("📦 Data:", data);

        // Check if it matches our criteria
        const isTargetApi = url.includes("recruiter-js-profile-services") ||
          url.includes("candidates") ||
          url.includes("contactdetails");

        // if (isTargetApi) console.log("🎯 TARGET API DETECTED:", url);

        window.postMessage(
          {
            source: "API_INTERCEPTOR",
            kind: "FETCH",
            url: clone.url,
            status: clone.status,
            data,
            pathname: window.location.pathname
          },
          "*"
        );

        // Trigger Naukri resume download from recruiter profile payload itself.
        triggerNaukriResumeDownloadIfPossible(data, clone.url);
      } else {
        // console.log("⏭️  Skipping non-JSON response for:", url);
      }
    } catch (e) {
      console.error("❌ Error intercepting fetch:", url, e);
    }

    return response;
  };

  // XHR
  const OriginalXHR = window.XMLHttpRequest;

  function InterceptedXHR() {
    const xhr = new OriginalXHR();

    // Track the URL from open()
    const originalOpen = xhr.open;
    xhr.open = function (...args) {
      // console.log("🔍 XHR.open() called with URL:", args[1]);
      return originalOpen.apply(this, args);
    };

    xhr.addEventListener("load", async function () {
      // console.log("🔍 XHR load event fired for:", xhr.responseURL);
      // console.log("📊 XHR Status:", xhr.status, "Ready State:", xhr.readyState);

      try {
        const ct = xhr.getResponseHeader("content-type") || "";
        // console.log("📋 XHR Content-Type:", ct);

        const isResumeApi =
          typeof xhr.responseURL === "string" &&
          (xhr.responseURL.includes("/jsprofile/download/resume") ||
            xhr.responseURL.includes("jsprofile/download/resume"));

        if (isResumeApi) {
          let cvBuffer = "";

          if (xhr.responseType === "blob" && xhr.response instanceof Blob) {
            cvBuffer = await blobToBase64(xhr.response);
          } else if (xhr.responseType === "arraybuffer" && xhr.response) {
            cvBuffer = arrayBufferToBase64(xhr.response);
          } else {
            // responseType is "" or "text"
            cvBuffer = xhr.responseText || "";

            // If the server sent binary PDF but responseType is text, this will be garbage.
            // In that case, prefer response if it's a Blob (some browsers do this).
            if (!cvBuffer && xhr.response instanceof Blob) {
              cvBuffer = await blobToBase64(xhr.response);
            }
          }

          console.log("📄 Resume API intercepted (xhr), sending cvBuffer to background");
          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data: { cvBuffer },
              pathname: window.location.pathname
            },
            "*"
          );
        } else if (ct.includes("application/json")) {
          const data = JSON.parse(xhr.responseText);

          // console.log("📤 Posting XHR message for:", xhr.responseURL);
          // console.log("📦 XHR Data:", data);

          // Check if it matches our criteria
          const isTargetApi = xhr.responseURL.includes("recruiter-js-profile-services") ||
            xhr.responseURL.includes("candidates") ||
            xhr.responseURL.includes("contactdetails");

          // if (isTargetApi) console.log("🎯 TARGET XHR API DETECTED:", xhr.responseURL);

          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data: data,
              pathname: window.location.pathname
            },
            "*"
          );

          // Trigger Naukri resume download from recruiter profile payload itself.
          triggerNaukriResumeDownloadIfPossible(data, xhr.responseURL);
        } else {
          // console.log("⏭️  Skipping non-JSON XHR response for:", xhr.responseURL);
        }
      } catch (e) {
        console.error("❌ Error intercepting XHR:", xhr.responseURL, e);
        try {
          if (typeof xhr.responseText === "string") {
            console.error("Response text:", xhr.responseText.substring(0, 200));
          }
        } catch (_ignored) {
          // xhr.responseText throws when responseType is blob/arraybuffer
        }
      }
    });

    return xhr;
  }

  window.XMLHttpRequest = InterceptedXHR;

  // console.log("✅ API Interceptor fully initialized (Fetch + XHR)");

  // Prevent the site from saving/opening the CV file.
  // We still allow the API call; we only block typical "download" mechanics.
  // this functionality is not used for the NJ it is back up for future use if needed
  // currently we have this but we are not using it for the NJ
  function installCvDownloadBlocker() {
    if (window.__api_interceptor_cv_blocker_installed) return;
    window.__api_interceptor_cv_blocker_installed = true;

    const shouldBlockNow = () =>
      typeof window.__api_interceptor_block_downloads_until === "number" &&
      Date.now() < window.__api_interceptor_block_downloads_until;

    // Block <a download> clicks / blob: navigations during the short window after we trigger Download CV.
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
      try {
        if (shouldBlockNow()) {
          const href = (this.getAttribute("href") || "").toLowerCase();
          const hasDownload = this.hasAttribute("download");
          if (hasDownload || href.startsWith("blob:")) {
            console.log("🛑 Blocked CV download anchor click");
            return;
          }
        }
      } catch (e) {
        // ignore
      }
      return originalAnchorClick.apply(this, args);
    };

    const originalWindowOpen = window.open;
    window.open = function (url, target, features) {
      try {
        if (shouldBlockNow() && typeof url === "string" && url.toLowerCase().startsWith("blob:")) {
          console.log("🛑 Blocked blob window.open during CV capture");
          return null;
        }
      } catch (e) {
        // ignore
      }
      return originalWindowOpen.call(window, url, target, features);
    };
  }

  // 🔥 AUTO-CLICK "View phone number" button to trigger contactdetails API
  function autoClickViewPhoneButton() {
    try {

      // ✅ Route guard: only run on /v3/preview
      if (!window.location.pathname.includes('/v3/preview')) {
        return false;
      }
      // Search all buttons for the one with "View phone number" text
      const buttons = document.querySelectorAll('button');

      for (const button of buttons) {
        const text = button.textContent || '';
        const hasPhoneText = text.toLowerCase().includes('view phone number') ||
          text.toLowerCase().includes('phone number');

        // Check if this button matches the criteria and hasn't been clicked yet
        if (hasPhoneText && !button.hasAttribute('data-auto-clicked')) {
          button.setAttribute('data-auto-clicked', 'true');
          console.log("🎯 Found 'View phone number' button:", button);
          console.log("🖱️  Auto-clicking button...");

          // Click the button
          button.click();

          console.log("✅ Button clicked! Waiting for contactdetails API call...");
          return true;
        }
      }

      return false;
    } catch (e) {
      console.error("❌ Error auto-clicking button:", e);
      return false;
    }
  }

  // 🔥 AUTO-CLICK "Download CV" button to trigger resume API (without saving file)
  //this also unused for the NJ it is back up for future use if needed
  function autoClickDownloadCvButton() {
    try {
      // ✅ Route guard: only run on preview pages
      if (!window.location.pathname.includes('/preview')) {
        return false;
      }

      const buttons = document.querySelectorAll("button");
      for (const button of buttons) {
        const text = (button.textContent || "").toLowerCase();
        // Some UIs put aria-label on the button itself, others on an inner div.
        const ariaOnButton = (button.getAttribute("aria-label") || "").toLowerCase();
        const ariaInside = (button.querySelector("[aria-label]")?.getAttribute("aria-label") || "").toLowerCase();
        const ariaLabel = ariaOnButton || ariaInside;

        const hasDownloadIcon = !!button.querySelector("i.naukri-icon-download");

        const isDownload =
          text.includes("download cv") ||
          text.includes("download resume") ||
          ariaLabel.includes("download resume") ||
          hasDownloadIcon;

        if (isDownload && !button.hasAttribute("data-auto-clicked-resume")) {
          button.setAttribute("data-auto-clicked-resume", "true");

          installCvDownloadBlocker();
          // Only block downloads briefly; still allow normal page actions afterward.
          window.__api_interceptor_block_downloads_until = Date.now() + 15000;

          console.log("🎯 Found 'Download CV' button:", button);
          console.log("🖱️  Auto-clicking Download CV button to trigger resume API...");
          button.click();
          return true;
        }
      }

      return false;
    } catch (e) {
      console.error("❌ Error auto-clicking Download CV button:", e);
      return false;
    }
  }

  // Try clicking immediately after 1.5 seconds
  setTimeout(() => {
    // console.log("⏰ Attempting auto-click after 1.5 seconds...");
    if (autoClickViewPhoneButton()) {
      // console.log("✅ Successfully auto-clicked on first attempt");
    }
    if (!isNaukriHost && autoClickDownloadCvButton()) {
      // console.log("✅ Successfully triggered Download CV on first attempt");
    }
  }, 1500);

  // Try again after 3 seconds in case the button loads later
  setTimeout(() => {
    // console.log("⏰ Attempting auto-click after 3 seconds...");
    if (autoClickViewPhoneButton()) {
      // console.log("✅ Successfully auto-clicked on second attempt");
    }
    if (!isNaukriHost && autoClickDownloadCvButton()) {
      // console.log("✅ Successfully triggered Download CV on second attempt");
    }
  }, 3000);

  // Watch for DOM changes to catch dynamically loaded buttons
  if (document.body) {
    const observer = new MutationObserver((mutations) => {
      // Only try if we see button-related changes
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          autoClickViewPhoneButton();
          if (!isNaukriHost) {
            autoClickDownloadCvButton();
          }
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // console.log("👀 MutationObserver watching for 'View phone number' button");
  }
})();

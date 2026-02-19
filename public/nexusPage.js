(function () {
  // console.log("🚀 API Interceptor nexusPage.js loaded");
  const isNaukriHost = /(^|\.)naukri\.com$/i.test(window.location.hostname);
  // Page-context script can't read extension storage. Content script posts EXT_AUTH_STATE.
  // Default false => don't intercept/click/download when not logged in.
  let extLoggedIn = false;
  window.addEventListener("message", (ev) => {
    try {
      if (ev.source !== window) return;
      if (ev.data?.source !== "EXT_AUTH_STATE") return;
      extLoggedIn = Boolean(ev.data?.loggedIn);
    } catch {
      // ignore
    }
  });
  const naukriResumeState = {
    inFlight: false,
    lastSignature: "",
  };
  const naukriHiringResumeState = {
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

  function isResdexPreviewPage() {
    const host = (window.location.hostname || "").toLowerCase();
    if (host !== "resdex.naukri.com") return false;
    return (window.location.pathname || "").includes("/v3/preview");
  }

  function installResdexViewPhoneUserClickTracker() {
    try {
      if (window.__nj_view_phone_user_click_tracker_installed) return;
      window.__nj_view_phone_user_click_tracker_installed = true;

      // Track user-initiated clicks so we don't auto-click after they already did.
      document.addEventListener(
        "click",
        (e) => {
          try {
            const t = e?.target;
            const el = t && typeof t.closest === "function" ? t.closest("button") : null;
            const text = (el?.textContent || "").toLowerCase();
            const isViewPhone = text.includes("view phone number") || text.includes("phone number");
            if (isViewPhone) {
              window.__nj_view_phone_user_clicked = true;
            }
          } catch {
            // ignore
          }
        },
        true
      );
    } catch {
      // ignore
    }
  }

  function markResdexContactDetailsSeen() {
    try {
      if (!isResdexPreviewPage()) return;
      window.__nj_contactdetails_seen = true;
    } catch {
      // ignore
    }
  }

  function scheduleResdexViewPhoneAutoClick() {
    try {
      if (!extLoggedIn) return false;
      if (!isResdexPreviewPage()) return false;

      installResdexViewPhoneUserClickTracker();

      if (window.__nj_view_phone_autoclick_started) return true;
      window.__nj_view_phone_autoclick_started = true;

      // Click sometime between 5-10 seconds unless user already triggered it.
      const delayMs = 5000 + Math.floor(Math.random() * 5000);

      window.setTimeout(() => {
        try {
          if (!extLoggedIn) return;
          if (!isResdexPreviewPage()) return;
          if (window.__nj_view_phone_user_clicked) return;
          if (window.__nj_contactdetails_seen) return;

          const buttons = document.querySelectorAll("button");
          for (const button of buttons) {
            const text = (button.textContent || "").toLowerCase();
            const hasPhoneText = text.includes("view phone number") || text.includes("phone number");
            if (!hasPhoneText) continue;
            if (button.hasAttribute("data-auto-clicked")) return;

            button.setAttribute("data-auto-clicked", "true");
            button.click();
            return;
          }
        } catch {
          // ignore
        }
      }, delayMs);

      return true;
    } catch {
      return false;
    }
  }

  function isNaukriHiringDetailsPage() {
    if (!isNaukriHost) return false;
    const host = (window.location.hostname || "").toLowerCase();
    if (host !== "hiring.naukri.com") return false;
    const path = window.location.pathname || "";
    return /\/hiring\/[^/]+\/apply\/[^/?#]+/i.test(path);
  }

  function extractHiringIdsFromLocation() {
    const path = window.location.pathname || "";
    const m = path.match(/\/hiring\/([^/]+)\/apply\/([^/?#]+)/i);
    return {
      jobId: m && m[1] ? String(m[1]) : "",
      applicationId: m && m[2] ? String(m[2]) : "",
    };
  }

  function ensureRmfileInput() {
    try {
      let el = document.getElementById("rmfile");
      if (el) return el;
      el = document.createElement("input");
      el.type = "hidden";
      el.id = "rmfile";
      el.value = "waiting";
      (document.body || document.documentElement).appendChild(el);
      return el;
    } catch {
      return null;
    }
  }

  function discoverHiringResumeBaseUrl(applicationId) {
    // Working_extension-style: Naukri exposes a global like `cvDwldUrl`.
    // Prefer that if present, else fall back to the known endpoint base.
    try {
      const g = window;
      const candidates = [g.cvDwldUrl, g.cvDownloadUrl, g.resumeDownloadUrl].filter(Boolean);
      for (const c of candidates) {
        if (typeof c === "string" && c.includes("/rm-document-services/") && c.includes("/download/applications/")) {
          return c.split("?")[0]; // keep base, we'll append params ourselves
        }
      }
    } catch {
      // ignore
    }

    if (!applicationId) return "";
    return (
      "https://hiring.naukri.com/cloudgateway-rm/rm-document-services/v0/download/applications/" +
      encodeURIComponent(applicationId)
    );
  }

  function buildNaukriHiringResumeUrl(jobId, applicationId) {
    const j = jobId ? String(jobId) : "";
    const a = applicationId ? String(applicationId) : "";
    if (!j || !a) return null;

    const rmfile = ensureRmfileInput();
    const fromDom = rmfile && typeof rmfile.value === "string" ? rmfile.value.trim() : "";
    const baseUrl =
      fromDom && fromDom !== "waiting"
        ? fromDom.split("?")[0]
        : discoverHiringResumeBaseUrl(a);

    if (!baseUrl) return null;

    // Important: applyType must be present but empty (applyType=).
    const resumeUrl = `${baseUrl}?jobId=${encodeURIComponent(j)}&applyType=`;

    // Persist to rmfile so other code can reuse it.
    try {
      if (rmfile) rmfile.value = resumeUrl;
    } catch {
      // ignore
    }

    return {
      resumeUrl,
      jobId: j,
      applicationId: a,
      signature: `${j}|${a}`,
    };
  }

  async function triggerNaukriHiringResumeDownloadIfPossible(payload, sourceUrl) {
    if (!extLoggedIn) return;
    if (!isNaukriHost) return;
    if (!isNaukriHiringDetailsPage()) return;
    if (typeof sourceUrl !== "string" || !sourceUrl.includes("rm-application-detail-services")) return;

    // Only trigger if application has resume.
    const hasResume = Boolean(payload && typeof payload === "object" && payload.hasResume);
    if (!hasResume) return;

    // jobId comes from the application-detail payload (most reliable).
    const locationIds = extractHiringIdsFromLocation();
    const jobId = payload && typeof payload === "object" ? String(payload.jobId || "") : "";
    const built = buildNaukriHiringResumeUrl(jobId || locationIds.jobId, locationIds.applicationId);
    if (!built) return;

    if (naukriHiringResumeState.inFlight || naukriHiringResumeState.lastSignature === built.signature) {
      return;
    }

    naukriHiringResumeState.inFlight = true;
    logNaukri("[NH] Calling download resume API", { resumeUrl: built.resumeUrl });

    try {
      // Use XHR so it is captured by our existing XHR resume interceptor.
      await new Promise((resolve, reject) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open("GET", built.resumeUrl, true);
        xhr.withCredentials = true;
        // Prefer raw bytes; if server returns base64 text we still handle it downstream.
        xhr.responseType = "arraybuffer";
        // Required by backend (matches browser request).
        xhr.setRequestHeader("Appid", "4");
        xhr.setRequestHeader("Systemid", "naukriIndia");
        xhr.setRequestHeader("accept", "application/json");
        xhr.setRequestHeader("content-type", "application/json");

        xhr.onload = () => {
          const ok = xhr.status >= 200 && xhr.status < 300;
          if (ok) {
            naukriHiringResumeState.lastSignature = built.signature;
          }
          resolve();
        };
        xhr.onerror = () => reject(new Error("XHR network error"));
        xhr.onabort = () => reject(new Error("XHR aborted"));
        xhr.send();
      });
    } catch (e) {
      logNaukri("[NH] Download resume API call failed", e);
    } finally {
      naukriHiringResumeState.inFlight = false;
    }
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
    if (!extLoggedIn) return;
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
    if (!extLoggedIn) return originalFetch(...args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "unknown";
    // console.log("🔍 Fetch intercepted BEFORE call:", url);

    const response = await originalFetch(...args);

    // console.log("🔍 Fetch intercepted AFTER call:", url, "Status:", response.status);

    try {
      const clone = response.clone();
      const ct = clone.headers.get("content-type") || "";

      // console.log("📋 Content-Type:", ct, "for URL:", url);

      const isResumeApi =
        typeof url === "string" &&
        (url.includes("/jsprofile/download/resume") ||
          url.includes("jsprofile/download/resume") ||
          (url.includes("rm-document-services") && url.includes("/download/applications/")));

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
        const nhIds = isNaukriHiringDetailsPage() ? extractHiringIdsFromLocation() : { jobId: "", applicationId: "" };
        window.postMessage(
          {
            source: "API_INTERCEPTOR",
            kind: "FETCH",
            url: clone.url,
            status: clone.status,
            data: { cvBuffer, nh_jobId: nhIds.jobId, nh_applicationId: nhIds.applicationId },
            pathname: window.location.pathname,
          },
          "*"
        );
      } else if (ct.includes("application/json")) {
        const data = await clone.json();

        // Check if it matches our criteria
        const isTargetApi =
          url.includes("recruiter-js-profile-services") ||
          url.includes("candidates") ||
          url.includes("contactdetails") ||
          url.includes("rm-application-detail-services");

        // if (isTargetApi) console.log("🎯 TARGET API DETECTED:", url);

        window.postMessage(
          {
            source: "API_INTERCEPTOR",
            kind: "FETCH",
            url: clone.url,
            status: clone.status,
            data,
            pathname: window.location.pathname,
          },
          "*"
        );

        if (typeof clone.url === "string" && clone.url.includes("contactdetails")) {
          markResdexContactDetailsSeen();
        }

        // Trigger Naukri resume download from recruiter profile payload itself.
        triggerNaukriResumeDownloadIfPossible(data, clone.url);
        // Trigger Naukri Hiring resume download from application-detail payload.
        triggerNaukriHiringResumeDownloadIfPossible(data, clone.url);
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
      return originalOpen.apply(this, args);
    };

    xhr.addEventListener("load", async function () {
      if (!extLoggedIn) return;

      try {
        const ct = xhr.getResponseHeader("content-type") || "";

        const isResumeApi =
          typeof xhr.responseURL === "string" &&
          (xhr.responseURL.includes("/jsprofile/download/resume") ||
            xhr.responseURL.includes("jsprofile/download/resume") ||
            (xhr.responseURL.includes("rm-document-services") &&
              xhr.responseURL.includes("/download/applications/")));

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
          const nhIds = isNaukriHiringDetailsPage() ? extractHiringIdsFromLocation() : { jobId: "", applicationId: "" };
          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data: { cvBuffer, nh_jobId: nhIds.jobId, nh_applicationId: nhIds.applicationId },
              pathname: window.location.pathname,
            },
            "*"
          );
        } else if (ct.includes("application/json")) {
          const data = JSON.parse(xhr.responseText);

          // Check if it matches our criteria
          const isTargetApi =
            xhr.responseURL.includes("recruiter-js-profile-services") ||
            xhr.responseURL.includes("candidates") ||
            xhr.responseURL.includes("contactdetails") ||
            xhr.responseURL.includes("rm-application-detail-services");

          // if (isTargetApi) console.log("🎯 TARGET XHR API DETECTED:", xhr.responseURL);

          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data,
              pathname: window.location.pathname,
            },
            "*"
          );

          if (typeof xhr.responseURL === "string" && xhr.responseURL.includes("contactdetails")) {
            markResdexContactDetailsSeen();
          }

          // Trigger Naukri resume download from recruiter profile payload itself.
          triggerNaukriResumeDownloadIfPossible(data, xhr.responseURL);
          // Trigger Naukri Hiring resume download from application-detail payload.
          triggerNaukriHiringResumeDownloadIfPossible(data, xhr.responseURL);
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

  // Prevent the site from saving/opening the CV file.
  // We still allow the API call; we only block typical "download" mechanics.
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
  function tryAutoClickHiringContactOnce() {
    try {
      if (!extLoggedIn) return false;
      if (!isNaukriHiringDetailsPage()) return false;

      // Click ONLY when still in "Contact" (phone icon) state.
      const containers = Array.from(document.querySelectorAll(".showContactContainer") || []);
      const target = containers.find((el) => {
        if (!el) return false;
        if (el.hasAttribute("data-auto-clicked")) return false;
        const btnText = (el.querySelector(".showContactContainerBtn")?.textContent || "").trim().toLowerCase();
        const hasPhoneIcon = !!el.querySelector("i.ore-phone");
        const hasCopyIcon = !!el.querySelector("i.ore-copy");
        // After click it becomes ore-copy + phone number; never click that state.
        return btnText === "contact" && hasPhoneIcon && !hasCopyIcon;
      });

      if (!target) return false;

      const btn = target.querySelector(".showContactContainerBtn");
      target.setAttribute("data-auto-clicked", "true");

      try {
        target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      } catch {
        // ignore
      }

      const fire = (el, type, Ctor, extra) => {
        try {
          el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, ...(extra || {}) }));
        } catch {
          // ignore
        }
      };

      // Some UIs bind to pointer events; fire a small sequence.
      const clickSeq = (el) => {
        if (!el) return;
        fire(el, "pointerdown", PointerEvent, { pointerId: 1, pointerType: "mouse", isPrimary: true });
        fire(el, "mousedown", MouseEvent);
        fire(el, "pointerup", PointerEvent, { pointerId: 1, pointerType: "mouse", isPrimary: true });
        fire(el, "mouseup", MouseEvent);
        fire(el, "click", MouseEvent);
        try {
          if (typeof el.click === "function") el.click();
        } catch {
          // ignore
        }
      };

      clickSeq(target);
      // Also click inner text node if handler is bound there.
      if (btn) clickSeq(btn);

      return true;
    } catch {
      return false;
    }
  }

  function scheduleHiringContactAutoClick(delayMs = 5000) {
    try {
      if (!extLoggedIn) return false;
      if (!isNaukriHiringDetailsPage()) return false;
      if (window.__nh_contact_autoclick_started) return true;
      window.__nh_contact_autoclick_started = true;

      const startDelay = Number.isFinite(delayMs) ? delayMs : 5000;
      window.setTimeout(() => {
        try {
          let tries = 0;
          const maxTries = 25; // ~25s retry window

          const tick = () => {
            tries += 1;
            if (tryAutoClickHiringContactOnce()) {
              return; // done
            }
            if (tries >= maxTries) return;
            window.setTimeout(tick, 1000);
          };

          tick();
        } catch {
          // ignore
        }
      }, startDelay);

      return true;
    } catch {
      return false;
    }
  }

  function autoClickViewPhoneButton() {
    try {
      if (!extLoggedIn) return false;

      // ✅ Route guard:
      // - Resdex preview: auto-click "View phone number"
      // - Hiring details: auto-click "Contact" container
      const path = window.location.pathname || "";
      const isResdexPreview = path.includes("/v3/preview");
      const isHiringDetail = isNaukriHiringDetailsPage();

      if (!isResdexPreview && !isHiringDetail) return false;

      if (isHiringDetail) {
        // Delay is required on Hiring pages; do not spam-click (can hit "copy" state).
        return scheduleHiringContactAutoClick(5000);
      }

      // Resdex preview: schedule auto-click between 5-10 seconds, unless user already clicked.
      return scheduleResdexViewPhoneAutoClick();
    } catch (e) {
      console.error("❌ Error auto-clicking button:", e);
      return false;
    }
  }

  // 🔥 AUTO-CLICK "Download CV" button to trigger resume API (without saving file)
  function autoClickDownloadCvButton() {
    try {
      // ✅ Route guard: only run on preview pages
      if (!window.location.pathname.includes("/preview")) {
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
    autoClickViewPhoneButton();
    if (!isNaukriHost) autoClickDownloadCvButton();
  }, 1500);

  // Try again after 3 seconds in case the button loads later
  setTimeout(() => {
    autoClickViewPhoneButton();
    if (!isNaukriHost) autoClickDownloadCvButton();
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
      subtree: true,
    });
  }
})();


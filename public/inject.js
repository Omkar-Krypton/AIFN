(function () {
  // console.log("🚀 API Interceptor inject.js loaded");

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
    xhr.open = function(...args) {
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
    if (autoClickDownloadCvButton()) {
      // console.log("✅ Successfully triggered Download CV on first attempt");
    }
  }, 1500);
  
  // Try again after 3 seconds in case the button loads later
  setTimeout(() => {
    // console.log("⏰ Attempting auto-click after 3 seconds...");
    if (autoClickViewPhoneButton()) {
      // console.log("✅ Successfully auto-clicked on second attempt");
    }
    if (autoClickDownloadCvButton()) {
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
          autoClickDownloadCvButton();
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

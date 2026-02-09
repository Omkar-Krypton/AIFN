(function () {
  console.log("🚀 API Interceptor inject.js loaded");
  
  // FETCH
  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || 'unknown';
    console.log("🔍 Fetch intercepted:", url);

    try {
      const clone = response.clone();
      const ct = clone.headers.get("content-type") || "";

      if (ct.includes("application/json")) {
        const data = await clone.json();
        
        console.log("📤 Posting message for:", url, data);

        window.postMessage(
          {
            source: "API_INTERCEPTOR",
            kind: "FETCH",
            url: clone.url,
            status: clone.status,
            data
          },
          "*"
        );
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

    xhr.addEventListener("load", function () {
      console.log("🔍 XHR intercepted:", xhr.responseURL);
      
      try {
        const ct = xhr.getResponseHeader("content-type") || "";
        if (ct.includes("application/json")) {
          const data = JSON.parse(xhr.responseText);
          
          console.log("📤 Posting XHR message for:", xhr.responseURL, data);
          
          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data: data
            },
            "*"
          );
        }
      } catch (e) {
        console.error("❌ Error intercepting XHR:", xhr.responseURL, e);
      }
    });

    return xhr;
  }

  window.XMLHttpRequest = InterceptedXHR;
  
  console.log("✅ API Interceptor fully initialized (Fetch + XHR)");
  
  // 🔥 AUTO-CLICK "View phone number" button to trigger contactdetails API
  function autoClickViewPhoneButton() {
    try {
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
  
  // Try clicking immediately after 1.5 seconds
  setTimeout(() => {
    console.log("⏰ Attempting auto-click after 1.5 seconds...");
    if (autoClickViewPhoneButton()) {
      console.log("✅ Successfully auto-clicked on first attempt");
    }
  }, 1500);
  
  // Try again after 3 seconds in case the button loads later
  setTimeout(() => {
    console.log("⏰ Attempting auto-click after 3 seconds...");
    if (autoClickViewPhoneButton()) {
      console.log("✅ Successfully auto-clicked on second attempt");
    }
  }, 3000);
  
  // Watch for DOM changes to catch dynamically loaded buttons
  if (document.body) {
    const observer = new MutationObserver((mutations) => {
      // Only try if we see button-related changes
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          autoClickViewPhoneButton();
          break;
        }
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    
    console.log("👀 MutationObserver watching for 'View phone number' button");
  }
})();

let freezeOverlay = null;

function freezePage(message = "Session expired. Please import again.") {
  if (freezeOverlay) return;

  freezeOverlay = document.createElement("div");
  freezeOverlay.id = "etica-freeze-overlay";
  freezeOverlay.innerHTML = `
    <div style="
      background:#fff;
      padding:24px 32px;
      border-radius:10px;
      text-align:center;
      max-width:380px;
      font-family:sans-serif;
    ">
      <h2>⛔ Access Locked</h2>
      <p>${message}</p>
    </div>
  `;

  Object.assign(freezeOverlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "999999",
  });

  document.body.appendChild(freezeOverlay);
  document.body.style.overflow = "hidden";
}

function unfreezePage() {
  if (freezeOverlay) {
    freezeOverlay.remove();
    freezeOverlay = null;
    document.body.style.overflow = "";
  }
}

function blockEvents(e) {
  e.preventDefault();
  e.stopPropagation();
}

function enableBlock() {
  ["click", "keydown", "wheel", "mousedown", "touchstart"].forEach((evt) => {
    window.addEventListener(evt, blockEvents, true);
  });
}

function disableBlock() {
  ["click", "keydown", "wheel", "mousedown", "touchstart"].forEach((evt) => {
    window.removeEventListener(evt, blockEvents, true);
  });
}

// Expose globally (other scripts call these)
window.freezePage = freezePage;
window.unfreezePage = unfreezePage;
window.enableBlock = enableBlock;
window.disableBlock = disableBlock;

// Listen to background messages
chrome.runtime.onMessage.addListener((msg) => {
  const hostname = location.hostname;

  const skipHosts = ["recruit.naukri.com", "hiring.naukri.com", "naukri.com"];

  // Skip freeze/unfreeze on certain pages
  if (skipHosts.includes(hostname)) {
    return;
  }

  if (msg.type === "FREEZE_PAGE") {
    freezePage(msg.message);
    enableBlock();
  }

  if (msg.type === "UNFREEZE_PAGE") {
    unfreezePage();
    disableBlock();
  }
});

// Initialize skipHosts cleanup
(function initializeSkipHosts() {
  const hostname = location.hostname;

  const skipHosts = ["recruit.naukri.com", "hiring.naukri.com"];

  if (skipHosts.includes(hostname)) {
    // Cleanup: make sure nothing is blocked
    disableBlock();
    unfreezePage();

    if (document.body) {
      document.body.style.overflow = "";
    }
    if (document.documentElement) {
      document.documentElement.style.overflow = "";
    }
  }
})();


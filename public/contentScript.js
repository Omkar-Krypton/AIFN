// Inject script into page context
const script = document.createElement("script");
script.src = chrome.runtime.getURL("inject.js");
script.onload = () => {
  console.log("✅ inject.js loaded and removed from DOM");
  script.remove();
};
(document.head || document.documentElement).appendChild(script);

console.log("🟢 Content script initialized");

// Listen messages from page
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.source === "API_INTERCEPTOR") {
    console.log("📨 Content script received message:", event.data.url);
    chrome.runtime.sendMessage(event.data);
  }
});

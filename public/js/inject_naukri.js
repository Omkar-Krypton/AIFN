(function naukriMainWorldInject() {
  // Intentionally minimal:
  // the working Naukri interception + resume trigger flow is centralized in public/inject.js.
  // Keeping this MAIN-world entry lightweight avoids duplicate hooks/API calls on naukri.com.
  if (window.__naukri_main_world_inject_installed) return;
  window.__naukri_main_world_inject_installed = true;
})();

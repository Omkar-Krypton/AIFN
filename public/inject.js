(function () {
  // FETCH
  const originalFetch = window.fetch;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);

    try {
      const clone = response.clone();
      const ct = clone.headers.get("content-type") || "";

      if (ct.includes("application/json")) {
        const data = await clone.json();

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
    } catch (e) {}

    return response;
  };

  // XHR
  const OriginalXHR = window.XMLHttpRequest;

  function InterceptedXHR() {
    const xhr = new OriginalXHR();

    xhr.addEventListener("load", function () {
      try {
        const ct = xhr.getResponseHeader("content-type") || "";
        if (ct.includes("application/json")) {
          window.postMessage(
            {
              source: "API_INTERCEPTOR",
              kind: "XHR",
              url: xhr.responseURL,
              status: xhr.status,
              data: JSON.parse(xhr.responseText)
            },
            "*"
          );
        }
      } catch (e) {}
    });

    return xhr;
  }

  window.XMLHttpRequest = InterceptedXHR;
})();

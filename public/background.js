chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source !== "API_INTERCEPTOR") return;

  const isJsProfileApi =
    typeof msg.url === "string" &&
    (msg.url.includes("recruiter-js-profile-services") ||
      msg.url.includes("candidates") || msg.url.includes("contactdetails")) &&
    msg.data &&
    msg.data.uniqueId;

  if (!isJsProfileApi) return;

  console.log("✅ JS PROFILE DATA FOUND (background):", msg.data);

  // 🔥 Send data to backend from the background service worker
  return sendCandidateData(msg.data);
});

async function sendCandidateData(data) {
  try {
    const res = await fetch(
      "http://localhost:5001/api/candidate-intercept-data",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(data),
      }
    );

    const result = await res.json();
    console.log("✅ Sent to backend (background):", result);
  } catch (err) {
    console.error("❌ Failed to send candidate data (background):", err);
  }
}


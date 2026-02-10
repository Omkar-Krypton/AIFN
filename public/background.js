chrome.runtime.onMessage.addListener((msg) => {
  console.log("🔔 Background received message:", msg?.url);
  
  if (msg?.source !== "API_INTERCEPTOR") {
    console.log("⏭️  Skipping: not from API_INTERCEPTOR");
    return;
  }

  // const isJsProfileApi =
  //   typeof msg.url === "string" &&
  //   (msg.url.includes("recruiter-js-profile-services") ||
  //     msg.url.includes("candidates") || msg.url.includes("contactdetails")) &&
  //   msg.data &&
  //   msg.data.uniqueId;

  const isJsProfileApi =
    typeof msg.url === "string" &&
    (msg.url.includes("recruiter-js-profile-services") ||
      msg.url.includes("candidates") || msg.url.includes("contactdetails")) 
  
  const isResumeApi = typeof msg.url === "string" && msg.url.includes("download/resume");


  if (!isJsProfileApi) {
    console.log("⏭️  Skipping: doesn't match criteria. URL:", msg.url, "Has uniqueId:", !!msg.data?.uniqueId);
    return;
  }

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


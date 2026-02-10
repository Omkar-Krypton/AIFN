const VERIFIED_IDS_API_URL = "http://localhost:2000/candidates/verified-ids";
const VERIFIED_IDS_BEARER_TOKEN =
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImE4YzQ2NjU1LTA2ODMtNDQ3OC1iYzFkLTIyOWVmYmMyOGJkMiIsImVtYWlsIjoic2hydXRpQHBsYWNvbmhyLmNvbSIsInJvbGUiOiJ1c2VyIiwiaXNBY3RpdmUiOnRydWUsImZ1bGxOYW1lIjoiU2hydXRpIiwibW9iaWxlIjoiMTIzNDU2Nzg5MCIsImxvY2F0aW9uIjoiQWhtZWRhYmFkIiwiY3VzdG9tZXJJZCI6IjhkMmY0MGFjLTk5YmEtNDk0Yy1iNWI1LTI4YmRjMzRiNDU2OCIsImlhdCI6MTc3MDcyNTYzMSwiZXhwIjoxOTI4NTEzNjMxfQ.X39paZs28FaRQs3pdohFWAM0jebLMKO8HLCzcm7DvEo";

let lastListingSignature = null;

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
  const isListingPage = typeof msg.pathname === "string" && msg.pathname.includes("search");
  const hasTuples = Array.isArray(msg?.data?.tuples);

  if (isListingPage && hasTuples) {
    return sendListingCandidatesData(msg.data);
  }

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

function extractFilteredCandidate(tuple) {
  return {
    jsUserName: tuple?.jsUserName || "",
    keySkills: tuple?.keySkills || "",
    focusedSkills: tuple?.focusedSkills || "",
    uniqueId: tuple?.uniqueId || "",
    education: tuple?.education || { ug: null, pg: null, ppg: null },
    employment: tuple?.employment || { current: null, previous: null },
    ctcInfo: tuple?.ctcInfo || null,
    experience: tuple?.experience || null,
    currentLocation: tuple?.currentLocation || "",
    preferredLocations: tuple?.preferredLocations || "",
    jsUserId: tuple?.jsUserId || null,
  };
}

function buildFrontPageDetail(candidate) {
  const companies = [];
  const currentEmployment = candidate?.employment?.current;
  const previousEmployment = candidate?.employment?.previous;

  if (currentEmployment && (currentEmployment.organization || currentEmployment.designation)) {
    companies.push({
      company_name: currentEmployment.organization || "",
      job_title: currentEmployment.designation || "",
      is_current: true,
    });
  }

  if (previousEmployment && (previousEmployment.organization || previousEmployment.designation)) {
    companies.push({
      company_name: previousEmployment.organization || "",
      job_title: previousEmployment.designation || "",
      is_current: false,
    });
  }

  const ugEducation = candidate?.education?.ug || {};

  return {
    name: candidate.jsUserName || "",
    email: "",
    phone: "",
    education: {
      degree: ugEducation.course || "",
      specialization: ugEducation.specialization || "",
      institute_name: ugEducation.institute || "",
    },
    companies,
  };
}

async function sendListingCandidatesData(data) {
  try {
    const tuples = Array.isArray(data?.tuples) ? data.tuples : [];
    if (!tuples.length) {
      console.log("⏭️  Listing payload has no tuples");
      return;
    }

    const filteredCandidates = tuples
      .map(extractFilteredCandidate)
      .filter((candidate) => candidate.uniqueId);

    if (!filteredCandidates.length) {
      console.log("⏭️  No valid candidate uniqueId found in tuples");
      return;
    }

    const signature = `${data?.sid || "no-sid"}:${filteredCandidates
      .map((candidate) => candidate.uniqueId)
      .join(",")}`;
    if (signature === lastListingSignature) {
      console.log("⏭️  Skipping duplicate listing payload");
      return;
    }
    lastListingSignature = signature;

    const payload = {
      jobBoard: "njb",
      ids: filteredCandidates.map((candidate) => candidate.uniqueId),
      jobBoardFrontPageDetails: filteredCandidates.map(buildFrontPageDetail),
    };

    const res = await fetch(VERIFIED_IDS_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        accept: "*/*",
        Authorization: VERIFIED_IDS_BEARER_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    const resultText = await res.text();
    console.log("✅ Sent listing candidates to verified-ids API:", {
      status: res.status,
      body: resultText,
      count: payload.ids.length,
    });
  } catch (err) {
    console.error("❌ Failed to send listing candidates data:", err);
  }
}


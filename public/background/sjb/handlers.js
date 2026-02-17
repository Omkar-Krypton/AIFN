/* global chrome */
import { PROFILE_API_URL, ETICA_EXT_URL } from "../../config/constants.js";
import { getStoredAuth } from "../core/auth.js";
import { sendNotification } from "../core/notifications.js";

function freezeTab(tabId, message) {
  if (!tabId) return;

  chrome.tabs
    .sendMessage(tabId, {
      type: "FREEZE_PAGE",
      message: message || "Session expired. Please import again.",
    })
    .catch(() => {
      // ignore
    });
}

export async function handleSjbProfile(message, sender, sendResponse) {
  sendResponse({ status: "processing" });

  getStoredAuth().then(async ({ storedToken }) => {
    let userId = null;

    if (storedToken) {
      try {
        const payload = JSON.parse(atob(storedToken.split(".")[1]));
        userId = payload._id || payload.id;
      } catch {
        // ignore
      }
    }

    // Extract resume data separately (not part of profile data)
    const resumePdfData = message.resumePdfData || null;
    const resumeFileName = message.resumeFileName || null;

    // Profile data without resume fields (resume is uploaded separately)
    const profileDataWithUserId = {
      ...message.data,
      source: "SJ",
    };

    // Remove resume fields from profile data if they exist (shouldn't be there, but just in case)
    delete profileDataWithUserId.resumePdfData;
    delete profileDataWithUserId.resumeFileName;

    fetch(`${PROFILE_API_URL}/candidates`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: storedToken ? `Bearer ${storedToken}` : "",
      },
      body: JSON.stringify(profileDataWithUserId),
    })
      .then(async (response) => {
        const responseBody = await response.json().catch(() => ({}));

        if (response.ok) {
          // Get user data for mapping
          const userResponse = await fetch(`${ETICA_EXT_URL}/profile/me`, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              Authorization: storedToken ? `Bearer ${storedToken}` : "",
            },
          });
          const userData = await userResponse.json().catch(() => ({}));

          // Prepare mapping data
          const mapData = {
            customerId: "",
            candidateId: "",
            scrappedBy: "",
            job_board: "SJ",
          };

          if (userResponse.ok) {
            // Extract candidate ID from response
            mapData.candidateId =
              responseBody?.data?.data?.profile?.id ||
              responseBody?.data?.data?.profile?._id ||
              responseBody?.data?.data?.id ||
              responseBody?.data?.data?._id ||
              responseBody?.data?.profile?.id ||
              responseBody?.data?.profile?._id ||
              responseBody?.data?.id ||
              responseBody?.data?._id ||
              responseBody?.id ||
              responseBody?._id ||
              responseBody?.person?._id ||
              responseBody?.person?.id ||
              responseBody?.candidate?.id ||
              responseBody?.candidate?._id ||
              "";
            mapData.scrappedBy = userData?.data?.data?._id || userData?.data?._id || "";
            mapData.customerId =
              userData?.data?.data?.customerId || userData?.data?.customerId || "";
          }

          // Call mapping API after candidate is saved
          if (mapData.candidateId && mapData.scrappedBy) {
            try {
              await fetch(`${ETICA_EXT_URL}/customer-candidate-mapping`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: storedToken ? `Bearer ${storedToken}` : "",
                },
                body: JSON.stringify(mapData),
              }).catch(() => null);

              // After mapping API, refresh Shine badges on all Shine tabs
              chrome.tabs.query({}, (allTabs) => {
                const shineTabs = (allTabs || []).filter((tab) => {
                  if (!tab.url) return false;
                  const url = tab.url.toLowerCase();
                  return url.includes("shine.com") || url.includes("recruiter.shine.com");
                });

                shineTabs.forEach((tab) => {
                  chrome.tabs
                    .sendMessage(tab.id, {
                      type: "SJB_REFRESH_BADGES",
                    })
                    .catch(() => {
                      // ignore
                    });
                });
              });

              // Also request extraction on the active profile tab
              if (sender.tab && sender.tab.id) {
                chrome.tabs
                  .sendMessage(sender.tab.id, {
                    type: "SJB_EXTRACT_AND_VERIFY_IDS",
                  })
                  .catch(() => {
                    // ignore
                  });
              }
            } catch (mapError) {
              console.error("[SJB Handler] Mapping API error:", mapError);
            }
          }

          // Extract candidate_id for resume upload - try multiple possible response structures
          const candidateId =
            responseBody?.data?.data?.profile?.id ||
            responseBody?.data?.data?.profile?._id ||
            responseBody?.data?.data?.id ||
            responseBody?.data?.data?._id ||
            responseBody?.data?.profile?.id ||
            responseBody?.data?.profile?._id ||
            responseBody?.data?.id ||
            responseBody?.data?._id ||
            responseBody?.id ||
            responseBody?._id ||
            responseBody?.person?._id ||
            responseBody?.person?.id ||
            responseBody?.candidate?.id ||
            responseBody?.candidate?._id ||
            "";

          // Send success message with candidate ID
          if (sender.tab && sender.tab.id) {
            chrome.tabs
              .sendMessage(sender.tab.id, {
                type: "SJB_PROFILE_SUCCESS",
                data: responseBody,
                candidateId: candidateId,
              })
              .catch(() => {
                // ignore
              });

            // Trigger resume upload after profile is saved if resumePdfData exists and candidateId is available
            if (resumePdfData && candidateId) {
              setTimeout(() => {
                chrome.tabs
                  .sendMessage(sender.tab.id, {
                    type: "SJB_TRIGGER_RESUME_UPLOAD",
                    candidateId: candidateId,
                    resumePdfData: resumePdfData,
                    resumeFileName: resumeFileName,
                  })
                  .catch(() => {
                    // ignore
                  });
              }, 2000);
            }
          } else {
            chrome.tabs.query({}, function (tabs) {
              for (let tab of tabs) {
                chrome.tabs
                  .sendMessage(tab.id, {
                    type: "SJB_PROFILE_SUCCESS",
                    data: responseBody,
                    candidateId: candidateId,
                  })
                  .catch(() => {
                    // ignore
                  });

                if (resumePdfData && candidateId) {
                  setTimeout(() => {
                    chrome.tabs
                      .sendMessage(tab.id, {
                        type: "SJB_TRIGGER_RESUME_UPLOAD",
                        candidateId: candidateId,
                        resumePdfData: resumePdfData,
                        resumeFileName: resumeFileName,
                      })
                      .catch(() => {
                        // ignore
                      });
                  }, 2000);
                }
              }
            });
          }

          sendNotification("Success");
        } else {
          chrome.tabs.query({}, function (tabs) {
            for (let tab of tabs) {
              chrome.tabs.sendMessage(tab.id, { type: "SJB_PROFILE_ERROR", data: responseBody }).catch(() => {
                // ignore
              });
            }
          });
        }
      })
      .catch((error) => {
        chrome.tabs.query({}, function (tabs) {
          for (let tab of tabs) {
            chrome.tabs
              .sendMessage(tab.id, { type: "SJB_PROFILE_ERROR", data: { error: error.message } })
              .catch(() => {
                // ignore
              });
          }
        });
        sendNotification("Fail");
      });
  });

  return false;
}

export async function handleSjbUpdateResume(message, sender, sendResponse) {
  // Send immediate response to prevent connection errors
  sendResponse({ status: "processing" });

  getStoredAuth().then(async ({ storedToken }) => {
    const requestBody = {
      candidate_id: message.data.candidate_id,
      cvBuffer: message.data.resumePdfData, // Base64 PDF buffer
      cvHtml: null,
      cv_updated_at: message.data.cv_updated_at || null,
    };

    fetch(`${PROFILE_API_URL}/candidates/upload-resume`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: storedToken ? `Bearer ${storedToken}` : "",
      },
      body: JSON.stringify(requestBody),
    })
      .then(async (response) => {
        const responseBody = await response.json().catch(() => ({}));
        if (response.ok) {
          if (sender.tab && sender.tab.id) {
            chrome.tabs
              .sendMessage(sender.tab.id, { type: "SJB_RESUME_UPDATE_SUCCESS", data: responseBody })
              .catch(() => {
                // ignore
              });
          }
        } else {
          if (sender.tab && sender.tab.id) {
            chrome.tabs
              .sendMessage(sender.tab.id, { type: "SJB_RESUME_UPDATE_ERROR", data: responseBody })
              .catch(() => {
                // ignore
              });
          }
        }
      })
      .catch((error) => {
        if (sender.tab && sender.tab.id) {
          chrome.tabs
            .sendMessage(sender.tab.id, { type: "SJB_RESUME_UPDATE_ERROR", data: { error: error.message } })
            .catch(() => {
              // ignore
            });
        }
        sendNotification("Fail");
      });
  });

  return false;
}

export async function handleCheckSjbIds(message, sendResponse) {
  try {
    const { storedToken } = await getStoredAuth();

    const response = await fetch(`${PROFILE_API_URL}/candidates/verified-ids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: storedToken ? `Bearer ${storedToken}` : "",
      },
      body: JSON.stringify({
        jobBoard: "sjb",
        ids: message.ids || [],
        jobBoardFrontPageDetails: message.jobBoardFrontPageDetails || [],
      }),
    });

    if (!response.ok) {
      sendResponse({ matched: { byId: [], byName: [] }, error: `API error: ${response.status}` });
      return true;
    }

    const data = await response.json();

    const matches = {
      byId: [],
      byName: [],
    };

    const results = Array.isArray(data) ? data : [data];

    results.forEach((item) => {
      if (item && item.match === true) {
        if (item.matched_by === "JOB_BOARD_ID") {
          matches.byId.push({
            index: item.index,
            candidateId: item.candidate_id,
            matchedBy: item.matched_by,
          });
        } else {
          matches.byName.push({
            index: item.index,
            name: item.name || "",
            candidateId: item.candidate_id,
            matchedBy: item.matched_by,
          });
        }
      }
    });

    const found = matches.byId.length > 0 || matches.byName.length > 0;

    sendResponse({
      matched: matches,
      found,
    });
    return true;
  } catch (err) {
    console.error("[SJB Handler] Error checking IDs:", err);
    sendResponse({ matched: { byId: [], byName: [] }, error: err.message });
    return true;
  }
}


/* global chrome */
import React, { useEffect, useState } from "react";
import {
  AlertCircle,
  Calendar,
  ChevronDown,
  CircleArrowRight,
  Globe,
  Loader2,
  RefreshCw,
  User,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "../config/api";
import { SS_BUILD_DATE, VERSION_DISPLAY } from "../config/version";
import { getStoredAuth, logOut } from "../utils/helper";
import ExtensionUpdateModal from "./ExtensionUpdateModal";
import Navbar from "./Navbar";

function ImportSession() {
  const navigate = useNavigate();
  const [activeSessions, setActiveSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [chromeVersion, setChromeVersion] = useState("");
  const [usersMap, setUsersMap] = useState(new Map());
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [latestExtensionVersion, setLatestExtensionVersion] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    if (!showUpdateModal) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow || "";
    };
  }, [showUpdateModal]);

  const fetchSessions = async () => {
    try {
      const { storedToken } = await getStoredAuth();
      if (!storedToken) return navigate("/login");

      // Fetch current user profile (also used for extension update modal).
      let currentUserCustomerId = null;
      try {
        const userProfileResponse = await fetch(`${API_URL}/api/ext/profile/me`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${storedToken}`,
          },
        });

        if (userProfileResponse.ok) {
          const userProfileData = await userProfileResponse.json();
          const userData = userProfileData?.data?.data || userProfileData?.data || userProfileData;
          if (userData) {
            currentUserCustomerId = userData.customerId || userData.customer_id || null;
            const latestVer = userData.latest_extension_version;
            const currentVer = import.meta.env.VITE_VERSION;
            if (latestVer && currentVer && latestVer !== currentVer) {
              setLatestExtensionVersion(latestVer);
              setShowUpdateModal(true);
            }
          }
        }
      } catch (userError) {
        console.log("Error fetching current user profile:", userError);
      }

      // Fetch users list for mapping sharer name.
      const usersResponse = await fetch(`${API_URL}/api/ext/sessions/users`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
        },
      });

      if (usersResponse.status === 401) {
        await logOut();
        return navigate("/login");
      }

      const usersResult = await usersResponse.json();
      let usersData = [];
      if (usersResult?.data) {
        if (usersResult.data.users && Array.isArray(usersResult.data.users)) {
          usersData = usersResult.data.users;
        } else if (Array.isArray(usersResult.data)) {
          usersData = usersResult.data;
        }
      }
      const userMap = new Map();
      usersData.forEach((user) => {
        const userId = user._id || user.id || user.userId;
        if (userId) userMap.set(userId, user);
      });
      setUsersMap(userMap);

      const sessionsResponse = await fetch(`${API_URL}/api/ext/sessions/active`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
        },
      });

      if (sessionsResponse.status === 401) {
        await logOut();
        return navigate("/login");
      }

      const result = await sessionsResponse.json();
      const sessionObj = result?.data || [];

      // Allow both Naukri + Shine sessions.
      let filteredSessions = Array.isArray(sessionObj)
        ? sessionObj.filter((s) => {
            const d = (s?.domain || "").toLowerCase();
            return d.includes("naukri") || d.includes("shine");
          })
        : [];

      if (currentUserCustomerId && Array.isArray(filteredSessions)) {
        filteredSessions = filteredSessions.filter(
          (session) => session.customer_id === currentUserCustomerId
        );
      }

      setActiveSessions(filteredSessions);
    } catch (err) {
      console.log("Session fetch error:", err);
      if (!navigator.onLine) {
        setError("No internet connection. Please check your network and try again.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    }
  };

  useEffect(() => {
    fetchSessions();
  }, [navigate]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchSessions();
    setIsRefreshing(false);
  };

  useEffect(() => {
    const getChromeVersion = async () => {
      if (navigator.userAgentData?.getHighEntropyValues) {
        try {
          const data = await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]);
          const chromeInfo = data.fullVersionList.find(
            (item) => item.brand === "Google Chrome" || item.brand === "Chromium"
          );
          if (chromeInfo?.version) {
            setChromeVersion(chromeInfo.version);
            return;
          }
        } catch (err) {
          console.warn("UA-CH failed:", err);
        }
      }

      if (typeof chrome !== "undefined" && chrome.runtime?.getBrowserInfo) {
        chrome.runtime.getBrowserInfo((info) => setChromeVersion(info?.version || "Unknown"));
        return;
      }

      const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
      if (chromeMatch?.[1]) {
        setChromeVersion(chromeMatch[1]);
        return;
      }
      setChromeVersion("Unknown");
    };
    getChromeVersion();
  }, []);

  const processImportSession = (message) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
          else resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });

  const proceedWithImport = async () => {
    setLoading(true);
    const fail = (msg) => {
      setError(msg);
      setSuccess("");
      setLoading(false);
    };

    try {
      if (!sessionId) return fail("Please select a session to import.");

      const { storedToken } = await getStoredAuth();
      if (!storedToken) {
        await logOut();
        return navigate("/login");
      }

      const response = await fetch(`${API_URL}/api/ext/sessions/import/${sessionId}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
        },
      });

      if (response.status === 401) {
        await logOut();
        return navigate("/login");
      }

      const resultData = await response.json();
      if (!response.ok) return fail(resultData?.message || "Failed to import session from server.");

      const sessionObj = resultData?.data;
      if (!sessionObj) return fail("Imported session data is empty or invalid.");

      await processImportSession({ action: "importSession", sessionData: sessionObj });

      setSuccess("Session imported successfully!");
      setError("");
    } catch (e) {
      console.error("Error importing session:", e);
      fail("An unexpected error occurred during import.");
    } finally {
      setLoading(false);
    }
  };

  const formatSessionDisplay = (session) => {
    const date = new Date(session.timestamp);
    const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });

    const displayDomain = (session?.domain || "").toLowerCase().includes("shine") ? "SJB" : "NJB";
    let sharerName = "Unknown";
    const userId = session.user_id;
    if (userId) {
      if (typeof userId === "object" && userId !== null) {
        sharerName = userId.full_name || userId.fullName || userId.email || "Unknown";
      } else if (typeof userId === "string") {
        const user = usersMap.get(userId);
        if (user) sharerName = user.fullName || user.full_name || user.email || "Unknown";
      }
    }

    return { displayDomain, sharerName, dateStr, time };
  };

  const selectedSession = activeSessions?.find((session) => session.id === sessionId);
  const selectedSessionDisplay = selectedSession ? formatSessionDisplay(selectedSession) : null;

  return (
    <div className="w-full max-w-[350px] mx-auto bg-transparent m-0 p-0">
      <Navbar />

      <div className="px-4 py-2 shadow-lg">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-lg font-semibold text-[#475467]">Import Feature</h1>
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className={`p-1.5 rounded-full hover:bg-gray-100 transition-all duration-200 text-gray-500 hover:text-gray-700 ${
              isRefreshing ? "animate-spin text-teal-600" : ""
            }`}
            title="Refresh Sessions"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 bg-teal-50 border border-teal-200 text-teal-700 px-4 py-3 rounded-md mb-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{success}</span>
          </div>
        )}

        <div className="mb-4">
          <label className="block text-sm font-medium text-[#475467] mb-1.5">
            Let's get started.
          </label>

          <div className="relative mb-1">
            <button
              type="button"
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className={`w-full px-2 py-2 bg-white border rounded-lg text-left transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 cursor-pointer ${
                isDropdownOpen ? "border-teal-500 shadow-lg" : "border-gray-300 hover:border-gray-400"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  {selectedSessionDisplay ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <div className="px-2 py-2 rounded text-xs font-medium bg-blue-100 text-blue-700">
                          {selectedSessionDisplay.displayDomain}
                        </div>
                        <span className="text-sm font-medium text-gray-700">
                          {selectedSessionDisplay.sharerName}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {selectedSessionDisplay.dateStr}
                        </div>
                        <div className="flex items-center gap-1">
                          <span>{selectedSessionDisplay.time}</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-gray-500">
                      <Globe className="w-4 h-4" />
                      <span className="text-sm">Select latest Link to collaborate</span>
                    </div>
                  )}
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                    isDropdownOpen ? "rotate-180" : ""
                  }`}
                />
              </div>
            </button>

            {isDropdownOpen && (
              <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden cursor-pointer">
                {activeSessions?.length === 0 ? (
                  <div className="px-2 py-2 text-center text-gray-500">
                    <Globe className="w-6 h-6 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No active links available</p>
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto">
                    {activeSessions?.map((session) => {
                      const sessionDisplay = formatSessionDisplay(session);
                      const isSelected = session.id === sessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => {
                            setSessionId(session.id);
                            setIsDropdownOpen(false);
                          }}
                          className={`w-full px-2 py-2 text-left hover:bg-gray-50 transition-colors duration-150 border-b border-gray-100 last:border-b-0 cursor-pointer ${
                            isSelected ? "bg-teal-50 border-teal-200" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <div className="px-2 py-0.5 rounded font-medium bg-teal-100 text-teal-700">
                              {sessionDisplay.displayDomain}
                            </div>
                            <div className="flex items-center gap-1 text-gray-600 flex-shrink-0">
                              <User className="w-3 h-3" />
                              <span className="text-sm font-medium truncate">
                                {sessionDisplay.sharerName}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-gray-500 flex-shrink-0">
                              <Calendar className="w-3 h-3" />
                              <span>
                                {sessionDisplay.dateStr} at {sessionDisplay.time}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <button
          onClick={(e) => {
            e.preventDefault();
            if (showUpdateModal) return;
            proceedWithImport();
          }}
          className="w-full text-white font-medium py-2 px-2 rounded-lg flex items-center justify-center space-x-2 text-sm transition-all duration-200 mb-5 cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed shadow-md hover:shadow-lg hover:opacity-90"
          style={{ backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689" }}
          disabled={loading}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              <span>Importing...</span>
            </>
          ) : (
            <>
              <span>Let's Start</span>
              <CircleArrowRight className="w-4 h-4 ml-2" />
            </>
          )}
        </button>

        <div className="mt-4 pt-3 border-t border-gray-200">
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-600 font-medium">Extension Version:</span>
              <span className="text-[10px] text-gray-500">{VERSION_DISPLAY}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-600 font-medium">Release Date:</span>
              <span className="text-[10px] text-gray-500">{SS_BUILD_DATE}</span>
            </div>
            {chromeVersion && (
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-gray-600 font-medium">Your Chrome Version:</span>
                <span className="text-[10px] text-gray-500">{chromeVersion}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {showUpdateModal && (
        <ExtensionUpdateModal
          newVersion={latestExtensionVersion}
          onClose={() => setShowUpdateModal(false)}
        />
      )}
    </div>
  );
}

export default ImportSession;


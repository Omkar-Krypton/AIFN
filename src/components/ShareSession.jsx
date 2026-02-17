/* global chrome */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, CircleArrowRight, Loader2, Search, Share2, Users, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "../config/api";
import { SS_BUILD_DATE, VERSION_DISPLAY } from "../config/version";
import { getAllowedDomains, getCurrentTabDomain, getStoredAuth, isNJBDomain, logOut } from "../utils/helper";
import ExtensionUpdateModal from "./ExtensionUpdateModal";
import Navbar from "./Navbar";

function ShareSession() {
  const [users, setUsers] = useState([]);
  const [isValidDomain, setIsValidDomain] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [isSelectAll, setIsSelectAll] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const [currentDomain, setCurrentDomain] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [chromeVersion, setChromeVersion] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [latestExtensionVersion, setLatestExtensionVersion] = useState(null);
  const dropdownRef = useRef();
  const navigate = useNavigate();

  useEffect(() => {
    const init = async () => {
      const fail = (msg) => {
        setError(msg);
        setSuccess("");
      };

      try {
        const allowedDomains = getAllowedDomains();
        const currentTabDomain = await getCurrentTabDomain();

        const isDomainAllowed =
          currentTabDomain &&
          (allowedDomains.includes(currentTabDomain) ||
            allowedDomains.includes(currentTabDomain.replace(/^www\./, "")) ||
            allowedDomains.includes(`www.${currentTabDomain}`));

        if (!isDomainAllowed) {
          setIsValidDomain(false);
          fail("Open Naukri (Resdex/Hiring) or Shine tab to share session.");
          return;
        }

        setIsValidDomain(true);
        setCurrentDomain(currentTabDomain);

        const { storedToken } = await getStoredAuth();
        if (!storedToken) {
          await logOut();
          return navigate("/login");
        }

        // Fetch current user for tagging the session owner + extension update modal.
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
              setCurrentUser({
                _id: userData._id || userData.id,
                fullName: userData.fullName || userData.full_name || userData.email || "User",
                email: userData.email || "",
              });

              const latestVer = userData.latest_extension_version;
              const currentVer = import.meta.env.VITE_VERSION;
              if (latestVer && currentVer && latestVer !== currentVer) {
                setLatestExtensionVersion(latestVer);
                setShowUpdateModal(true);
              }
            }
          }
        } catch (e) {
          console.log("Profile fetch failed:", e);
        }

        const response = await fetch(`${API_URL}/api/ext/sessions/users`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        });

        if (response.status === 401) {
          await logOut();
          return navigate("/login");
        }

        const data = await response.json();
        if (!response.ok) {
          fail(data?.message || "Failed to fetch users from the server.");
          return;
        }

        // API might return { data: { users, teams } } or { data: [] }
        const usersList =
          data?.data?.users && Array.isArray(data.data.users) ? data.data.users : (data?.data || []);
        setUsers(Array.isArray(usersList) ? usersList : []);
        setError("");
      } catch (e) {
        fail("Internal server error.");
        console.error(e);
      }
    };

    init();
  }, [navigate]);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, []);

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
      if (chromeMatch?.[1]) setChromeVersion(chromeMatch[1]);
      else setChromeVersion("Unknown");
    };
    getChromeVersion();
  }, []);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const fullName = (u.fullName || u.full_name || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      return fullName.includes(q) || email.includes(q);
    });
  }, [users, searchQuery]);

  const grabSessionData = (message) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => resolve(response));
    });

  const toggleUser = (userId) => {
    setSelectedUserIds((prev) => {
      const next = prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId];
      return next;
    });
  };

  const toggleAll = () => {
    if (searchQuery.trim()) {
      const ids = filteredUsers.map((u) => u._id || u.id || u.userId).filter(Boolean);
      const allSelected = ids.length > 0 && ids.every((id) => selectedUserIds.includes(id));
      if (allSelected) {
        setSelectedUserIds((prev) => prev.filter((id) => !ids.includes(id)));
      } else {
        setSelectedUserIds((prev) => [...new Set([...prev, ...ids])]);
      }
      return;
    }

    const allIds = users.map((u) => u._id || u.id || u.userId).filter(Boolean);
    const next = !isSelectAll;
    setIsSelectAll(next);
    setSelectedUserIds(next ? allIds : []);
  };

  useEffect(() => {
    if (searchQuery.trim()) return;
    const allIds = users.map((u) => u._id || u.id || u.userId).filter(Boolean);
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedUserIds.includes(id));
    setIsSelectAll(allSelected);
  }, [selectedUserIds, users, searchQuery]);

  const handleShareSession = async () => {
    if (showUpdateModal) return;
    setLoading(true);

    const fail = (msg) => {
      setError(msg);
      setSuccess("");
      setLoading(false);
    };

    try {
      if (!isValidDomain) return fail("Open a Naukri or Shine tab first.");
      if (!isSelectAll && selectedUserIds.length === 0) return fail("Select at least 1 user.");

      // NJB rule: share max 4 users unless select-all.
      if (isNJBDomain(currentDomain) && !isSelectAll && selectedUserIds.length > 4) {
        return fail("Share session allowed up to 4 users.");
      }

      const grabSessionResponse = await grabSessionData({ action: "shareSession" });
      if (!grabSessionResponse?.status) return fail(grabSessionResponse?.message || "Failed to export session.");

      const sessionData = grabSessionResponse.data;
      const { storedToken } = await getStoredAuth();
      if (!storedToken) {
        await logOut();
        return navigate("/login");
      }

      const sessionDataWithUser = {
        ...sessionData,
        user_id: currentUser
          ? { _id: currentUser._id, fullName: currentUser.fullName, email: currentUser.email }
          : sessionData.user_id,
      };

      const requestBody = {
        session: sessionDataWithUser,
        user_ids: isSelectAll ? undefined : selectedUserIds,
        is_all: isSelectAll,
      };

      const response = await fetch(`${API_URL}/api/ext/sessions/share`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (response.status === 401) {
        await logOut();
        return navigate("/login");
      }

      const resultData = await response.json();
      if (!response.ok) return fail(resultData?.message || "Something went wrong on the server.");

      setSuccess(resultData.message || "Session shared successfully");
      setError("");
      await chrome.storage.local.set({ exportSessions: sessionDataWithUser });
    } catch (e) {
      console.error("Error in handleShareSession:", e);
      fail("Internal server error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAllNaukriSessions = async () => {
    setDeleting(true);
    setError("");
    setSuccess("");
    try {
      const { storedToken } = await getStoredAuth();
      if (!storedToken) {
        await logOut();
        return navigate("/login");
      }

      const response = await fetch(`${API_URL}/api/ext/sessions/naukri`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${storedToken}` },
      });

      if (response.status === 401) {
        await logOut();
        return navigate("/login");
      }

      const resultData = await response.json();
      if (response.ok) {
        setSuccess("All Naukri sessions deleted successfully");
      } else {
        setError(resultData?.message || "Failed to delete Naukri sessions");
      }
    } catch (e) {
      console.error("Error deleting Naukri sessions:", e);
      setError("Failed to delete Naukri sessions: " + e.message);
    } finally {
      setDeleting(false);
    }
  };

  const selectionText = isSelectAll
    ? `All users selected (${users.length})`
    : selectedUserIds.length
      ? `${selectedUserIds.length} user${selectedUserIds.length > 1 ? "s" : ""} selected`
      : "Select users to collaborate";

  return (
    <div className="w-full max-w-[350px] mx-auto bg-transparent m-0 p-0">
      <Navbar />
      <div className="px-4 py-2 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[#475467]">Collaborate (Naukri/Shine)</h1>
          <button
            type="button"
            disabled={deleting}
            onClick={handleDeleteAllNaukriSessions}
            className="text-[10px] px-2 py-1 rounded border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60"
            title="Delete all Naukri sessions"
          >
            {deleting ? "Deleting..." : "Delete Sessions"}
          </button>
        </div>

        {error && (
          <div className="mb-4">
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-2 bg-teal-50 border border-teal-200 text-teal-700 px-4 py-3 rounded-md mb-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{success}</span>
          </div>
        )}

        {isValidDomain && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-[#475467] mb-1.5">
              Let's collaborate with your team
            </label>

            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className={`w-full px-2 py-2 bg-white border rounded-lg text-left transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 cursor-pointer ${
                  dropdownOpen ? "border-teal-500 shadow-lg" : "border-gray-300 hover:border-gray-400"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-teal-700" />
                    <span className="text-sm text-teal-700">{selectionText}</span>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                      dropdownOpen ? "rotate-180" : ""
                    }`}
                  />
                </div>
              </button>

              {dropdownOpen && (
                <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden text-xs">
                  <div className="p-2 border-b border-gray-100">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-3 h-3 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search users..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-7 pr-7 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="border-b border-gray-100">
                    <button
                      type="button"
                      onClick={toggleAll}
                      className="w-full px-2 py-1.5 text-left hover:bg-teal-50 transition-colors duration-150 flex items-center gap-2 cursor-pointer"
                    >
                      <div className="relative">
                        {/*
                          Note: we render our own check icon so the small checkbox
                          stays visible even with Tailwind base styles.
                        */}
                        <input
                          type="checkbox"
                          readOnly
                          checked={
                            searchQuery.trim()
                              ? filteredUsers.length > 0 &&
                                filteredUsers.every((u) =>
                                  selectedUserIds.includes(u._id || u.id || u.userId)
                                )
                              : isSelectAll
                          }
                          className="w-3 h-3 text-teal-600 rounded border-gray-300 focus:ring-teal-500 cursor-pointer"
                        />
                        {(searchQuery.trim()
                          ? filteredUsers.length > 0 &&
                            filteredUsers.every((u) =>
                              selectedUserIds.includes(u._id || u.id || u.userId)
                            )
                          : isSelectAll) && (
                          <Check className="w-2.5 h-2.5 text-teal-600 absolute top-[2px] left-[2px] pointer-events-none" />
                        )}
                      </div>
                      <span className="font-medium text-gray-900">
                        Select All Users ({filteredUsers.length})
                      </span>
                    </button>
                  </div>

                  <div className="max-h-40 overflow-y-auto">
                    {filteredUsers.length === 0 ? (
                      <div className="px-2 py-2 text-center text-gray-500">
                        <Users className="w-5 h-5 mx-auto mb-1 opacity-50" />
                        <p className="text-xs">{searchQuery ? "No users found" : "No users available"}</p>
                      </div>
                    ) : (
                      filteredUsers.map((user) => {
                        const userId = user._id || user.id || user.userId;
                        const isSelected = selectedUserIds.includes(userId);
                        return (
                          <button
                            key={userId || user.email}
                            type="button"
                            onClick={() => toggleUser(userId)}
                            className={`w-full px-2 py-1.5 flex items-center gap-2 border-b border-gray-50 last:border-b-0 text-left transition-colors duration-150 hover:bg-teal-50 cursor-pointer ${
                              isSelected ? "bg-teal-50 border-teal-200" : ""
                            }`}
                          >
                            <div className="relative">
                              <input
                                type="checkbox"
                                readOnly
                                checked={isSelected}
                                className="w-3 h-3 text-teal-600 rounded border-gray-300 focus:ring-teal-500 cursor-pointer"
                              />
                              {isSelected && (
                                <Check className="w-2.5 h-2.5 text-teal-600 absolute top-[2px] left-[2px] pointer-events-none" />
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-medium text-gray-900 truncate">
                                {user.fullName || user.full_name || "Unnamed User"}
                              </p>
                              <p className="text-[10px] text-gray-500 truncate">{user.email}</p>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 p-2 border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => {
                        handleShareSession();
                        setDropdownOpen(false);
                      }}
                      disabled={loading || (!isSelectAll && selectedUserIds.length === 0)}
                      className={`flex-1 font-medium py-1.5 px-3 rounded-md flex items-center justify-center gap-1.5 text-xs transition-all duration-200 ${
                        loading || (!isSelectAll && selectedUserIds.length === 0)
                          ? "bg-gray-400 cursor-not-allowed opacity-70"
                          : "text-white hover:shadow-md cursor-pointer hover:opacity-90"
                      }`}
                      style={{
                        backgroundColor:
                          loading || (!isSelectAll && selectedUserIds.length === 0)
                            ? undefined
                            : (import.meta.env.VITE_PRIMARY_COLOR || "#009689"),
                      }}
                    >
                      {loading ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Sharing...</span>
                        </>
                      ) : (
                        <>
                          <span>Collaborate</span>
                          <CircleArrowRight className="w-3 h-3" />
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDropdownOpen(false)}
                      className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-md transition-colors duration-150"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <div className="text-[#D92D20] font-bold">
            <h2 className="text-sm mb-2 flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Important:
            </h2>
            <div className="space-y-1">
              <p className="text-[10px] leading-relaxed font-normal">
                Step 1 : Select users to collaborate.
              </p>
              <p className="text-[10px] leading-relaxed font-normal">
                Step 2 : Click on Collaborate button.
              </p>
            </div>
          </div>
        </div>

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
        <ExtensionUpdateModal newVersion={latestExtensionVersion} onClose={() => setShowUpdateModal(false)} />
      )}
    </div>
  );
}

export default ShareSession;


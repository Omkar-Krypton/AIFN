/* global chrome */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, CircleArrowRight, Loader2, Search, User, Users, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "../config/api";
import { SS_BUILD_DATE, VERSION_DISPLAY } from "../config/version";
import { getAllowedDomains, getCurrentTabDomain, getStoredAuth, isNJBDomain, logOut } from "../utils/helper";
import ExtensionUpdateModal from "./ExtensionUpdateModal";
import Navbar from "./Navbar";

function ShareSession() {
  const [users, setUsers] = useState([]);
  const [teams, setTeams] = useState([]);
  const [isValidDomain, setIsValidDomain] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState([]);
  const [selectedTeamIds, setSelectedTeamIds] = useState([]);
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
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [selectedTeamMembers, setSelectedTeamMembers] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [latestExtensionVersion, setLatestExtensionVersion] = useState(null);
  const [membersLoading, setMembersLoading] = useState(false);
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
        setMembersLoading(true)

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

        // Handle Working_extension structure:
        // { status, message, data: { teams: [...], users: [...] } }
        if (data?.data) {
          if (data.data.teams && Array.isArray(data.data.teams)) {
            setTeams(data.data.teams || []);
          } else {
            setTeams([]);
          }

          if (data.data.users && Array.isArray(data.data.users)) {
            setUsers(data.data.users || []);
          } else {
            // Fallback: older response where `data` itself is users array
            const allUsers = data.data || [];
            setUsers(Array.isArray(allUsers) ? allUsers : []);
            setTeams([]);
          }
          setMembersLoading(false);
        } else {
          setUsers(Array.isArray(data?.data) ? data.data : []);
          setTeams([]);
          setMembersLoading(false);
        }
        setError("");
      } catch (e) {
        setMembersLoading(false);
        fail("Internal server error.");
        console.error(e);
      }
    };

    init();
  }, [navigate]);

  useEffect(() => {
    const handleOutsideClick = (e) => {
      // Do nothing if members modal is open (Working_extension behavior)
      if (showMembersModal) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [showMembersModal]);

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

  const filteredTeams = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((t) => String(t?.name || "").toLowerCase().includes(q));
  }, [teams, searchQuery]);

  const grabSessionData = (message) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => resolve(response));
    });

  const toggleUser = (userId, e) => {
    if (e) e.stopPropagation();
    if (isSelectAll) setIsSelectAll(false);
    setSelectedUserIds((prev) => {
      const next = prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId];
      return next;
    });
  };

  const toggleTeam = (teamId, e) => {
    if (e) e.stopPropagation();
    if (isSelectAll) setIsSelectAll(false);

    setSelectedTeamIds((prev) => (prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId]));
  };

  const toggleAll = (e) => {
    if (e) e.stopPropagation();
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

  const handleShowTeamMembers = (team, e) => {
    if (e) e.stopPropagation();
    setDropdownOpen(false);
    setSelectedTeamMembers(team);
    setShowMembersModal(true);
  };

  const handleCloseMembersModal = () => {
    setShowMembersModal(false);
    setSelectedTeamMembers(null);
  };

  const selectionSummary = useMemo(() => {
    const totalSelections = selectedUserIds.length + selectedTeamIds.length;
    if (isSelectAll) {
      return `All users selected (${users.length})`;
    }
    if (totalSelections > 0) {
      const parts = [];
      if (selectedTeamIds.length > 0) parts.push(`${selectedTeamIds.length} team${selectedTeamIds.length > 1 ? "s" : ""}`);
      if (selectedUserIds.length > 0) parts.push(`${selectedUserIds.length} user${selectedUserIds.length > 1 ? "s" : ""}`);
      return `${parts.join(", ")} selected`;
    }
    return "Select teams or users to collaborate";
  }, [isSelectAll, selectedTeamIds.length, selectedUserIds.length, users.length]);

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
      if (!isSelectAll && selectedUserIds.length === 0 && selectedTeamIds.length === 0) return fail("Select at least 1 team or user.");

      // NJB rule: share max 4 users unless select-all.
      if (isNJBDomain(currentDomain)) {
        const totalSelectedUsers = isSelectAll ? users?.length : selectedUserIds.length;
        if (totalSelectedUsers > 4 && selectedTeamIds.length === 0) {
          return fail("Share session allowed up to 4 users.");
        }
      }

      // Keep legacy behavior (if user selects >4 users but also selected a team, allow).
      if (isNJBDomain(currentDomain) && !isSelectAll && selectedUserIds.length > 4 && selectedTeamIds.length === 0) {
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
        user_ids: selectedUserIds.length > 0 ? selectedUserIds : undefined,
        team_ids: selectedTeamIds.length > 0 ? selectedTeamIds : undefined,
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

 

  return (
    <div className="w-full max-w-[350px] mx-auto bg-transparent m-0 p-0">
      <Navbar />
      <div className="px-4 py-2 shadow-lg">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-semibold text-[#475467]">Collaborate</h1>
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

        {showMembersModal && selectedTeamMembers && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-3">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-[300px] max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between p-3 border-b border-gray-200 bg-gradient-to-r from-teal-50 to-teal-100">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-teal-600 rounded-full flex items-center justify-center">
                    <Users className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 leading-tight">{selectedTeamMembers.name}</h3>
                    <p className="text-[11px] text-gray-600">
                      {selectedTeamMembers.memberCount || 0} member{selectedTeamMembers.memberCount !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCloseMembersModal}
                  className="p-1.5 rounded-md text-gray-700 hover:bg-white/60"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 overflow-hidden flex flex-col">
                <div className="px-3 py-2 bg-gray-50">
                  <p className="text-[10px] font-semibold text-gray-700 uppercase tracking-wide">Team Members</p>
                </div>

                <div className="flex-1 overflow-y-auto px-3 py-2">
                  {selectedTeamMembers.members?.length > 0 ? (
                    <div className="space-y-1.5">
                      {selectedTeamMembers.members.map((member) => (
                        <div key={member.id} className="flex items-start gap-2 p-2 bg-white border border-gray-200 rounded-md">
                          <div className="w-8 h-8 bg-gradient-to-br from-teal-400 to-teal-600 rounded-full flex items-center justify-center">
                            <User className="w-4 h-4 text-white" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-gray-900 truncate">
                              {member.fullName || "Unnamed User"}
                            </p>
                            <p className="text-[11px] text-gray-600 truncate">{member.email}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Users className="w-6 h-6 text-gray-400 mb-1" />
                      <p className="text-xs font-semibold text-gray-700">No members found</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-3 border-t border-gray-200 bg-gray-50">
                <button
                  type="button"
                  onClick={handleCloseMembersModal}
                  className="w-full px-3 py-2 text-xs font-semibold text-white rounded-md transition-colors hover:opacity-90"
                  style={{ backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689" }}
                >
                  Close
                </button>
              </div>
            </div>
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
                      <span className="text-sm text-teal-700">{selectionSummary}</span>
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
                          placeholder="Search teams or users..."
                        value={searchQuery}
                          onChange={(e) => {
                            e.stopPropagation();
                            setSearchQuery(e.target.value);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        className="w-full pl-7 pr-7 py-1.5 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSearchQuery("");
                            }}
                          className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                    {filteredTeams.length > 0 && (
                      <div className="border-b border-gray-100">
                        <div className="px-2 py-1.5 bg-gray-50">
                          <span className="text-[10px] font-semibold text-gray-600 uppercase">Teams</span>
                        </div>

                        {filteredTeams.map((team) => {
                          const isSelected = selectedTeamIds.includes(team.id);
                          return (
                            <button
                              key={team.id}
                              type="button"
                              onClick={(e) => {
                                if (e.target?.type === "checkbox") return;
                                e.stopPropagation();
                                toggleTeam(team.id, e);
                              }}
                              className={`w-full px-2 py-1.5 flex items-center gap-2 border-b border-gray-50 last:border-b-0 text-left transition-colors duration-150 hover:bg-teal-50 cursor-pointer ${
                                isSelected ? "bg-teal-50 border-teal-200" : ""
                              }`}
                            >
                              <div className="relative" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => toggleTeam(team.id, e)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-3 h-3 text-teal-600 rounded border-gray-300 focus:ring-teal-500 cursor-pointer"
                                />
                                {isSelected && (
                                  <Check className="w-2.5 h-2.5 text-teal-600 absolute top-[2px] left-[2px] pointer-events-none" />
                                )}
                              </div>

                              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                <Users className="w-3 h-3 text-teal-600 flex-shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-medium text-gray-900 truncate">{team.name}</p>
                                  <button
                                    type="button"
                                    onClick={(e) => handleShowTeamMembers(team, e)}
                                    className="text-[10px] text-teal-600 hover:text-teal-700 hover:underline cursor-pointer"
                                  >
                                    {team.memberCount || 0} member{team.memberCount !== 1 ? "s" : ""}
                                  </button>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {filteredUsers.length > 0 && (
                      <div className="px-2 py-1.5 bg-gray-50 border-b border-gray-100">
                        <span className="text-[10px] font-semibold text-gray-600 uppercase">Users</span>
                      </div>
                    )}

                  <div className="border-b border-gray-100">
                    <button
                      type="button"
                        onClick={(e) => {
                          if (e.target?.type === "checkbox") return;
                          toggleAll(e);
                        }}
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
  {membersLoading ? (
    <div className="px-2 py-3 flex items-center justify-center text-gray-500">
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      <span className="text-xs">Loading teams/users...</span>
    </div>
  ) : filteredUsers.length === 0 ? (
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
                            onClick={(e) => {
                              if (e.target?.type === "checkbox") return;
                              toggleUser(userId, e);
                            }}
                            className={`w-full px-2 py-1.5 flex items-center gap-2 border-b border-gray-50 last:border-b-0 text-left transition-colors duration-150 hover:bg-teal-50 cursor-pointer ${
                              isSelected ? "bg-teal-50 border-teal-200" : ""
                            }`}
                          >
                            <div className="relative">
                              <input
                                type="checkbox"
                                readOnly
                                checked={isSelected}
                                onClick={(e) => e.stopPropagation()}
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
                      disabled={loading || (!isSelectAll && selectedUserIds.length === 0 && selectedTeamIds.length === 0)}
                      className={`flex-1 font-medium py-1.5 px-3 rounded-md flex items-center justify-center gap-1.5 text-xs transition-all duration-200 ${
                        loading || (!isSelectAll && selectedUserIds.length === 0 && selectedTeamIds.length === 0)
                          ? "bg-gray-400 cursor-not-allowed opacity-70"
                          : "text-white hover:shadow-md cursor-pointer hover:opacity-90"
                      }`}
                      style={{
                        backgroundColor:
                          loading || (!isSelectAll && selectedUserIds.length === 0 && selectedTeamIds.length === 0)
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


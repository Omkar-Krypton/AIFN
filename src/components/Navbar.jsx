/* global chrome */
import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CloudDownload, House, Loader2, LogOut, Share2 } from "lucide-react";
import { API_URL } from "../config/api";
import ExtensionUpdateModal from "./ExtensionUpdateModal";
import { getStoredAuth, logOutAndClearCookies } from "../utils/helper";

function Navbar({ onExtensionUpdateChange }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [chromeVersion, setChromeVersion] = useState("");
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [latestExtensionVersion, setLatestExtensionVersion] = useState(null);

  const getChromeVersion = async () => {
    if (navigator.userAgentData?.getHighEntropyValues) {
      try {
        const data = await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]);
        const chromeInfo = data.fullVersionList.find(
          (item) => item.brand === "Google Chrome" || item.brand === "Chromium"
        );
        if (chromeInfo?.version) return chromeInfo.version;
      } catch (err) {
        console.warn("UA-CH failed:", err);
      }
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.getBrowserInfo) {
      return new Promise((resolve) => {
        chrome.runtime.getBrowserInfo((info) => resolve(info?.version || "Unknown"));
      });
    }

    const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
    if (chromeMatch?.[1]) return chromeMatch[1];
    return "Unknown";
  };

  const isActive = (path) => location.pathname === path;

  const handleLogout = async () => {
    setLoading(true);
    const { storedToken } = await getStoredAuth();

    try {
      await fetch(`${API_URL}/api/ext/auth/logout`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${storedToken}`,
          "x-chrome-version": chromeVersion || "Unknown",
        },
      });
    } catch {
      // ignore network errors
    }

    await logOutAndClearCookies();
    setLoading(false);
    navigate("/login");
  };

  useEffect(() => {
    const initChromeVersion = async () => {
      const version = await getChromeVersion();
      setChromeVersion(version);
    };
    initChromeVersion();
  }, []);

  useEffect(() => {
    if (!showUpdateModal) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow || "";
    };
  }, [showUpdateModal]);

  useEffect(() => {
    const fetchCurrentUser = async () => {
      try {
        const { storedToken } = await getStoredAuth();
        if (!storedToken) return;

        const userProfileResponse = await fetch(`${API_URL}/api/ext/profile/me`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${storedToken}`,
            "x-chrome-version": chromeVersion || "Unknown",
          },
        });

        if (!userProfileResponse.ok) {
          if (onExtensionUpdateChange) onExtensionUpdateChange(false);
          return;
        }

        const userProfileData = await userProfileResponse.json().catch(() => ({}));
        const userData = userProfileData?.data?.data || userProfileData?.data || userProfileData;

        if (userData) {
          setCurrentUser({
            fullName: userData.fullName || userData.full_name || userData.email || "User",
            email: userData.email || "",
          });

          const latestVer = userData.latest_extension_version;
          const currentVer = import.meta.env.VITE_VERSION;
          if (latestVer && currentVer && latestVer !== currentVer) {
            setLatestExtensionVersion(latestVer);
            setShowUpdateModal(true);
            if (onExtensionUpdateChange) onExtensionUpdateChange(true);
          } else if (onExtensionUpdateChange) {
            onExtensionUpdateChange(false);
          }
        }
      } catch (error) {
        console.error("Error fetching current user profile:", error);
      }
    };

    if (chromeVersion) {
      fetchCurrentUser();
    }
  }, [chromeVersion]);

  return (
    <>
      <div
        style={{ backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689" }}
        className="py-1 flex items-center justify-between text-white w-full max-w-[350px] mx-auto"
      >
        <div className="flex items-center gap-2 ml-4">
          <img src="/wcircleLogo.svg" alt="logo" className="w-6 h-6" />
          {currentUser && (
            <span className="text-[11px] text-white opacity-90">{currentUser.fullName}</span>
          )}
        </div>
        <div className="flex items-center mr-2">
          <div
            className={`cursor-pointer px-4 py-2 transition-colors ${
              isActive("/home") ? "bg-[#00786f] -my-1 py-3" : ""
            }`}
            onClick={() => navigate("/home")}
          >
            <House className="w-4 h-4" />
          </div>
          <div
            className={`cursor-pointer px-4 py-2 transition-colors ${
              isActive("/import-session") ? "bg-[#00786f] -my-1 py-3" : ""
            }`}
            onClick={() => navigate("/import-session")}
          >
            <CloudDownload className="w-4 h-4" />
          </div>
          <div
            className={`cursor-pointer px-4 py-2 transition-colors ${
              isActive("/share-session") ? "bg-[#00786f] -my-1 py-3" : ""
            }`}
            onClick={() => navigate("/share-session")}
          >
            <Share2 className="w-4 h-4" />
          </div>
          <div
            className="cursor-pointer px-4 py-2 transition-colors hover:bg-[#00786f] hover:-my-1 hover:py-3 hover:bg-opacity-10 ml-0.5"
            onClick={handleLogout}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          </div>
        </div>
      </div>

      {showUpdateModal && (
        <ExtensionUpdateModal
          newVersion={latestExtensionVersion}
          onClose={() => {
            setShowUpdateModal(false);
            if (onExtensionUpdateChange) onExtensionUpdateChange(false);
          }}
        />
      )}
    </>
  );
}

export default Navbar;


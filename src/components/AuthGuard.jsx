/* global chrome */
import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { API_URL } from "../config/api";
import { connectSocket } from "../service/socket.service";
import { getStoredAuth, logOutAndClearCookies } from "../utils/helper";

const AuthGuard = ({ children }) => {
  const [authStatus, setAuthStatus] = useState("checking"); // 'checking' | 'authenticated' | 'unauthenticated'

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

  useEffect(() => {
    const checkAuthentication = async () => {
      const { storedToken } = await getStoredAuth();

      if (!storedToken) {
        setAuthStatus("unauthenticated");
        return;
      }

      // Optimistic auth while checking (important for popup reopen).
      setAuthStatus("authenticated");

      try {
        const chromeVersion = await getChromeVersion();

        let response;
        try {
          response = await fetch(`${API_URL}/api/ext/profile/me`, {
            headers: {
              Authorization: `Bearer ${storedToken}`,
              "x-chrome-version": chromeVersion || "Unknown",
            },
          });
        } catch (fetchError) {
          // Offline / network failure: keep authenticated.
          console.log("Auth check fetch failed:", fetchError);
          return;
        }

        if (response?.status === 401 || response?.status === 403) {
          // Token invalid/expired: force logout and show message on login screen.
          try {
            const data = await response.json();
            if (data?.message) {
              if (chrome?.storage?.local) {
                await new Promise((resolve) =>
                  chrome.storage.local.set({ forceLogoutMessage: data.message }, resolve)
                );
              } else {
                localStorage.setItem("forceLogoutMessage", data.message);
              }
            }
          } catch {
            // ignore JSON/message issues
          }

          // Explicitly clear extension auth/session state so stale tokens are not left behind
          // even if this check runs when the popup is first opened.
          try {
            await logOutAndClearCookies();
          } catch {
            // Never block UI if cleanup fails
          }

          setAuthStatus("unauthenticated");
          return;
        }

        setAuthStatus("authenticated");

        connectSocket(
          async (data) => {
            const message =
              data?.message ||
              "You have logged in on another device. Previous session logged out.";

            if (chrome?.storage?.local) {
              await new Promise((resolve) =>
                chrome.storage.local.set({ forceLogoutMessage: message }, resolve)
              );
            } else {
              localStorage.setItem("forceLogoutMessage", message);
            }

            // Backend force-logout: clear cookies/session as well.
            await logOutAndClearCookies();
            setAuthStatus("unauthenticated");
          },
          storedToken
        );
      } catch (error) {
        console.log("Auth check wrapper error:", error);
        setAuthStatus("authenticated");
      }
    };

    checkAuthentication();
  }, []);

  if (authStatus === "checking") {
    return (
      <div className="w-full max-w-[350px] mx-auto bg-white rounded-lg shadow-lg p-4 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-2"></div>
          <p className="text-sm text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (authStatus === "authenticated") return children;
  return <Navigate to="/login" replace />;
};

export default AuthGuard;


/* global chrome */
import React, { useEffect, useState } from "react";
import { CloudDownload, Share2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Navbar from "../components/Navbar";
import { SS_BUILD_DATE, VERSION_DISPLAY } from "../config/version";

function Home() {
  const navigate = useNavigate();
  const [chromeVersion, setChromeVersion] = useState("");
  const [isExtensionUpdateOpen, setIsExtensionUpdateOpen] = useState(false);

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
        chrome.runtime.getBrowserInfo((info) => {
          setChromeVersion(info?.version || "Unknown");
        });
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

  return (
    <div
      className={`w-full max-w-[350px] mx-auto bg-transparent m-0 p-0 flex flex-col${
        isExtensionUpdateOpen ? " min-h-[480px]" : ""
      }`}
    >
      <Navbar onExtensionUpdateChange={setIsExtensionUpdateOpen} />
      <div
        className={`bg-white rounded-b-2xl p-4 shadow-lg w-full${
          isExtensionUpdateOpen ? " flex-1" : ""
        }`}
      >
        <div className="space-y-2 w-full">
          <div
            className="border border-gray-200 rounded-md p-2 hover:shadow-md transition-shadow cursor-pointer w-full"
            onClick={() => navigate("/import-session")}
          >
            <div className="flex items-center space-x-2 w-full">
              <div className="w-10 h-10 flex items-center justify-center">
                <CloudDownload className="w-6 h-6 text-[#1849A9]" />
              </div>
              <div className="w-full">
                <h2 className="text-[14px] font-semibold text-[#1849A9]">
                  Import - Get Started
                </h2>
              </div>
            </div>
          </div>

          <div
            className="border border-gray-200 rounded-md p-2 hover:shadow-md transition-shadow cursor-pointer w-full"
            onClick={() => navigate("/share-session")}
          >
            <div className="flex items-center space-x-2 w-full">
              <div className="w-10 h-10 flex items-center justify-center">
                <Share2 className="w-6 h-6 text-[#05603A]" />
              </div>
              <div className="w-full">
                <h2 className="text-[14px] font-semibold text-[#05603A]">
                  Share - Collaborate with team
                </h2>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-200">
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-600 font-medium">
                Extension Version:
              </span>
              <span className="text-[10px] text-gray-500">{VERSION_DISPLAY}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[10px] text-gray-600 font-medium">Release Date:</span>
              <span className="text-[10px] text-gray-500">{SS_BUILD_DATE}</span>
            </div>
            {chromeVersion && (
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-gray-600 font-medium">
                  Your Chrome Version:
                </span>
                <span className="text-[10px] text-gray-500">{chromeVersion}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default Home;


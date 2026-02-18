/* global chrome */
import { AlertCircle, Eye, EyeOff, Loader2 } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_URL } from "../config/api";
import { SS_BUILD_DATE, VERSION_DISPLAY } from "../config/version";
import { setStoredAuth } from "../utils/helper";
import { getDeviceInfo } from "../../utils/deviceInfo.js";

function Login() {
  const [error, setError] = useState("");
  const [alreadyLoginError, setAlreadyLoginError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [chromeVersion, setChromeVersion] = useState("");
  const [form, setForm] = useState({ email: "", password: "" });
  const [formErrors, setFormErrors] = useState({ email: "", password: "" });
  const [isFormValid, setIsFormValid] = useState(false);
  const navigate = useNavigate();

  function getBrowserName() {
    const ua = navigator.userAgent;
    if (ua.includes("Edg/")) return "Microsoft Edge";
    if (ua.includes("OPR/")) return "Opera";
    if (navigator.brave) return "Brave";
    if (navigator.vendor === "Google Inc.") return "Google Chrome";
    return "Unknown";
  }

  async function getOSName() {
    const ua = navigator.userAgent;
    const platform = navigator.platform.toLowerCase();

    if (platform.includes("win")) {
      const match = ua.match(/Windows NT (\d+\.\d+)/);
      let version = "Unknown";
      if (match) {
        const nt = match[1];
        if (nt === "10.0") {
          if (navigator.userAgentData?.getHighEntropyValues) {
            const data = await navigator.userAgentData.getHighEntropyValues(["platformVersion"]);
            const pv = parseFloat(data.platformVersion);
            version = pv >= 13 ? "11" : "10";
          } else {
            version = "10";
          }
        }
        if (nt === "6.3") version = "8.1";
        if (nt === "6.2") version = "8";
        if (nt === "6.1") version = "7";
      }
      return `Windows ${version}`;
    }

    if (platform.includes("mac")) {
      const m = ua.match(/Mac OS X (\d+[_|\.\d]+)/);
      const version = m ? m[1].replace(/_/g, ".") : "Unknown";
      return `MacOS ${version}`;
    }
    if (platform.includes("linux")) return "Linux";
    return "Unknown";
  }

  useEffect(() => {
    const initLogOut = async () => {
      let msg = localStorage.getItem("forceLogoutMessage");
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        const data = await new Promise((resolve) =>
          chrome.storage.local.get(["forceLogoutMessage"], resolve)
        );
        if (data.forceLogoutMessage) msg = data.forceLogoutMessage;
        await new Promise((resolve) => chrome.storage.local.remove(["forceLogoutMessage"], resolve));
      }
      localStorage.removeItem("forceLogoutMessage");
      if (msg) setError(msg);
    };
    initLogOut();
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
      if (chromeMatch?.[1]) {
        setChromeVersion(chromeMatch[1]);
        return;
      }
      setChromeVersion("Unknown");
    };
    getChromeVersion();
  }, []);

  const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email) return "Email is required";
    if (!emailRegex.test(email)) return "Please enter a valid email address";
    return "";
  };

  const validatePassword = (password) => {
    if (!password) return "Password is required";
    if (password.length < 1) return "Password cannot be empty";
    return "";
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));

    let fieldError = "";
    if (name === "email") fieldError = validateEmail(value);
    if (name === "password") fieldError = validatePassword(value);

    setFormErrors((prev) => ({ ...prev, [name]: fieldError }));

    const newErrors = { ...formErrors, [name]: fieldError };
    const allFieldsFilled = (name === "email" ? value : form.email) && (name === "password" ? value : form.password);
    const hasNoErrors = !newErrors.email && !newErrors.password;
    setIsFormValid(Boolean(allFieldsFilled && hasNoErrors));
  };

  const validateForm = () => {
    const errors = {
      email: validateEmail(form.email),
      password: validatePassword(form.password),
    };
    setFormErrors(errors);
    const hasErrors = errors.email || errors.password;
    const allFieldsFilled = form.email && form.password;
    setIsFormValid(Boolean(allFieldsFilled && !hasErrors));
    return !hasErrors && allFieldsFilled;
  };

  const handleSubmit = async (e) => {
    if (e?.preventDefault) e.preventDefault();

    // Attach device info (backend uses it for session/device validation).
    const payload = {
      ...form,
      browser_name: getBrowserName(),
      os_name: await getOSName(),
      extension_version: import.meta.env.VITE_VERSION || "Unknown",
    };

    try {
      const deviceInfo = await getDeviceInfo();
      if (deviceInfo && typeof deviceInfo === "object" && Object.keys(deviceInfo).length) {
        payload.deviceInfo = deviceInfo;
      }
    } catch {
      // Never block login on device info collection failure.
    }

    setError("");
    if (!validateForm()) return;
    setLoading(true);

    if (alreadyLoginError) {
      setAlreadyLoginError(false);
      payload.confirm = true;
      payload.extensionLogin = true;
    }

    try {
      const response = await fetch(`${API_URL}/api/ext/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));
      const result = data?.data;

      if (!response.ok) {
        if (response.status === 409) {
          setError("");
          setAlreadyLoginError(true);
          return;
        }
        setError(data?.message || "Login failed");
        return;
      }

      const accessToken = result?.access_token;
      if (!accessToken) {
        setError("No token received from server");
        return;
      }

      await setStoredAuth({ authToken: accessToken });

      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: "updateUninstallURL", token: accessToken });
      }

      navigate("/home");
    } catch (err) {
      console.log("Login network error:", err);
      if (!navigator.onLine) {
        setError("No internet connection. Please check your network and try again.");
      } else {
        setError("Unable to reach server. Please try again later.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[350px] mx-auto bg-transparent m-0 p-0">
      <div className="bg-white rounded-lg shadow-lg p-4 w-full flex flex-col justify-center">
        <h2 className="text-xl font-semibold text-left text-gray-800 mb-6">User Login</h2>

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {alreadyLoginError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md p-4 mb-4 shadow-sm">
            <div className="flex items-start gap-3 mb-4">
              <AlertCircle className="h-6 w-6 flex-shrink-0 mt-1" />
              <p className="text-sm leading-relaxed">
                You are already logged in on another device. Do you want to log in on
                this device instead? If you continue, you will be logged out from the
                other device.
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setAlreadyLoginError(false)}
                className="px-4 py-2 rounded border border-teal-600 text-teal-600 hover:bg-teal-100 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="px-4 py-2 rounded text-white transition cursor-pointer hover:opacity-90"
                style={{ backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689" }}
              >
                Login
              </button>
            </div>
          </div>
        )}

        <form
          className={`flex-1 flex flex-col justify-center space-y-4 w-full ${
            alreadyLoginError ? "hidden" : ""
          }`}
          onSubmit={handleSubmit}
          noValidate
        >
          <div>
            <input
              type="email"
              name="email"
              value={form.email}
              onChange={handleChange}
              onBlur={() => validateForm()}
              placeholder="Email ID"
              required
              className={`w-full px-2 py-2 bg-gray-50 border ${
                formErrors.email ? "border-red-300" : "border-gray-200"
              } rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition-all duration-200`}
            />
            {formErrors.email && (
              <p className="text-red-500 text-xs mt-1 ml-1">{formErrors.email}</p>
            )}
          </div>

          <div>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                value={form.password}
                onChange={handleChange}
                onBlur={() => validateForm()}
                placeholder="Password"
                required
                className={`w-full px-2 py-2 pr-12 bg-gray-50 border ${
                  formErrors.password ? "border-red-300" : "border-gray-200"
                } rounded-lg text-gray-900 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent transition-all duration-200`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {formErrors.password && (
              <p className="text-red-500 text-xs mt-1 ml-1">{formErrors.password}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !isFormValid}
            className={`w-full text-white font-medium py-2 px-4 rounded-lg transition-colors duration-200 flex items-center justify-center gap-2 mt-2 ${
              !isFormValid ? "cursor-not-allowed" : "cursor-pointer"
            }`}
            style={{
              backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689",
              opacity: !isFormValid ? 0.6 : 1,
            }}
          >
            {loading ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

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
    </div>
  );
}

export default Login;


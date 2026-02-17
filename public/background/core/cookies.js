import { getPlatformInfo } from "./session.js";

export async function validateCrossPlatformCookies(targetUrl, expectedCookies) {
  try {
    const url = new URL(targetUrl);
    const actualCookies = await chrome.cookies.getAll({ domain: url.hostname });

    const authPatterns = [
      /session/i,
      /auth/i,
      /token/i,
      /login/i,
      /user/i,
      /member/i,
      /jsessionid/i,
      /phpsessid/i,
      /aspsessionid/i,
      /naukri/i,
      /resdex/i,
      /dashboard/i,
      /profile/i,
    ];

    const foundAuthCookies = actualCookies.filter((cookie) => {
      return authPatterns.some((pattern) => pattern.test(cookie.name));
    });

    const platformInfo = await getPlatformInfo();

    return {
      totalExpected: expectedCookies.length,
      totalFound: actualCookies.length,
      authCookiesFound: foundAuthCookies.length,
      platform: platformInfo.os,
      success: actualCookies.length > 0 && foundAuthCookies.length > 0,
    };
  } catch (error) {
    console.error("Cross-platform cookie validation error:", error);
    return { success: false, error: error.message };
  }
}

export async function validateNaukriSession(targetUrl, expectedCookies) {
  try {
    const currentCookies = await chrome.cookies.getAll({ domain: "naukri.com" });
    const currentCookieNames = currentCookies.map((c) => c.name);

    const criticalCookies = expectedCookies.filter(
      (cookie) =>
        cookie.domain.includes("naukri.com") &&
        (cookie.name.includes("auth") || cookie.name.includes("session") || cookie.name.includes("token"))
    );

    for (const cookie of criticalCookies) {
      if (!currentCookieNames.includes(cookie.name)) {
        await setCriticalNaukriCookie(cookie, "naukri.com");
      }
    }

    return { success: true, cookiesFound: currentCookieNames.length };
  } catch (error) {
    console.error("Naukri session validation error:", error);
    return { success: false, error: error.message };
  }
}

export async function validateShineSession(targetUrl, expectedCookies) {
  try {
    const currentCookies = await chrome.cookies.getAll({ domain: "shine.com" });
    const currentCookieNames = currentCookies.map((c) => c.name);

    const criticalCookies = expectedCookies.filter(
      (cookie) =>
        cookie.domain.includes("shine.com") &&
        (cookie.name.includes("auth") ||
          cookie.name.includes("session") ||
          cookie.name.includes("token") ||
          cookie.name.includes("user"))
    );

    for (const cookie of criticalCookies) {
      if (!currentCookieNames.includes(cookie.name)) {
        await setCriticalShineCookie(cookie, "shine.com");
      }
    }

    return { success: true, cookiesFound: currentCookieNames.length };
  } catch (error) {
    console.error("Shine session validation error:", error);
    return { success: false, error: error.message };
  }
}

async function setCriticalNaukriCookie(cookie, hostname) {
  const strategies = [
    {
      url: `https://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: cookie.expirationDate,
    },
    {
      url: `https://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: true,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: cookie.expirationDate,
    },
    {
      url: `http://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: cookie.expirationDate,
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      await new Promise((resolve, reject) => {
        chrome.cookies.set(strategies[i], (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
      return;
    } catch (error) {
      console.error(`Strategy ${i + 1} failed for critical cookie ${cookie.name}:`, error);
    }
  }
}

async function setCriticalShineCookie(cookie, hostname) {
  const strategies = [
    {
      url: `https://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      secure: true,
      httpOnly: false,
      sameSite: "lax",
      expirationDate: cookie.expirationDate,
    },
    {
      url: `https://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: true,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: cookie.expirationDate,
    },
    {
      url: `http://${hostname}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: cookie.expirationDate,
    },
  ];

  for (let i = 0; i < strategies.length; i++) {
    try {
      await new Promise((resolve, reject) => {
        chrome.cookies.set(strategies[i], (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
      return;
    } catch (error) {
      console.error(`Strategy ${i + 1} failed for critical cookie ${cookie.name}:`, error);
    }
  }
}


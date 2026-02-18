// Device info for login payload.
// Screen metrics must be collected from a windowed context (content/popup), not from MV3 service worker.

function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function compactObject(input) {
  if (!isPlainObject(input)) return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) continue;
      out[k] = s;
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
      out[k] = v;
      continue;
    }
    if (isPlainObject(v)) {
      const nested = compactObject(v);
      if (isPlainObject(nested) && Object.keys(nested).length === 0) continue;
      out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function getCpuInfo() {
  try {
    if (!globalThis.chrome?.system?.cpu?.getInfo) return {};
    const info = await new Promise((resolve) => {
      try {
        chrome.system.cpu.getInfo((result) => resolve(result || null));
      } catch {
        resolve(null);
      }
    });
    return compactObject({
      cpuModal: typeof info?.modelName === "string" ? info.modelName : undefined,
      cpuArchitecture: typeof info?.archName === "string" ? info.archName : undefined,
      cpuCores: typeof info?.numOfProcessors === "number" ? Number(info.numOfProcessors) : undefined,
    });
  } catch {
    return {};
  }
}

function getTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" ? tz.trim() : "";
  } catch {
    return "";
  }
}

function getScreenInfoFromWindow() {
  try {
    if (typeof window === "undefined") return {};
    if (!window.screen) return {};
    return compactObject({
      width: typeof window.screen.width === "number" ? Number(window.screen.width) : undefined,
      height: typeof window.screen.height === "number" ? Number(window.screen.height) : undefined,
      pixelRatio: typeof window.devicePixelRatio === "number" ? Number(window.devicePixelRatio) : undefined,
    });
  } catch {
    return {};
  }
}

async function getScreenInfoViaContentScript() {
  // MV3 service worker has no window/screen; ask an active tab's content script.
  try {
    if (!globalThis.chrome?.tabs?.query || !globalThis.chrome?.tabs?.sendMessage) return {};
    const tab = await new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve((tabs || [])[0] || null));
      } catch {
        resolve(null);
      }
    });
    if (!tab?.id) return {};

    const resp = await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tab.id, { type: "GET_SCREEN_INFO" }, (r) => {
          // When no content script is present, lastError is set; treat as unavailable.
          resolve(r || null);
        });
      } catch {
        resolve(null);
      }
    });

    return compactObject({
      width: typeof resp?.width === "number" ? Number(resp.width) : undefined,
      height: typeof resp?.height === "number" ? Number(resp.height) : undefined,
      pixelRatio: typeof resp?.pixelRatio === "number" ? Number(resp.pixelRatio) : undefined,
    });
  } catch {
    return {};
  }
}

export async function getScreenInfo() {
  const fromWindow = getScreenInfoFromWindow();
  if (Object.keys(fromWindow).length) return fromWindow;
  return await getScreenInfoViaContentScript();
}

export async function getDeviceInfo() {
  try {
    const [cpu, screen] = await Promise.all([getCpuInfo(), getScreenInfo()]);
    const deviceInfo = compactObject({
      ...cpu,
      timeZone: getTimeZone() || undefined,
      screen: Object.keys(screen).length ? screen : undefined,
    });
    return deviceInfo;
  } catch {
    return {};
  }
}


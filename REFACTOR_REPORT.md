# Chrome Extension Refactor Report

## SECTION A — Files Modified

| File | Changes |
|------|---------|
| `public/contentScript.js` | Replaced `postMessage(..., "*")` with `postMessage(..., window.location.origin)` in `postAuthStateToPage()` |
| `public/content/sjb/extractor.js` | Replaced `postMessage(..., "*")` with `postMessage(..., window.location.origin)` for SJB_PROFILE_DATA |
| `public/nexusPage.js` | (1) Replaced 4× `postMessage(..., "*")` with `window.location.origin`; (2) Added `isRequestUrlRelevant()` helper; (3) Scoped fetch/XHR handlers to skip processing when request URL does not match resume/download/contact patterns; (4) Added `isRelevantPageForDownloadBlock()` and scoped `HTMLAnchorElement.prototype.click` / `window.open` overrides to only act on preview/profile/hiring pages |
| `scripts/obfuscate.js` | Removed `inject.js` from `allowRoot` set and `isContentScript` check |
| `public/inject.js` | **DELETED** — Unused duplicate of nexusPage.js (see Section B) |

---

## SECTION B — Why Changes Are Safe

### 1. postMessage targetOrigin
- **Before:** `"*"` allows any origin to receive the message (security risk).
- **After:** `window.location.origin` restricts delivery to the same origin.
- **Safe because:** All postMessage usage is same-document (content script ↔ page context on the same tab). The content script and injected page script share the same `window` and origin. `window.location.origin` is correct for this use case.

### 2. Prototype override scoping
- **Fetch/XHR:** Added `isRequestUrlRelevant(url)` check. When the request URL does not match resume/download/contact patterns, the handler returns immediately without cloning or parsing the response. This narrows side effects to relevant API calls only.
- **Anchor/window.open:** Added `isRelevantPageForDownloadBlock()` so blocking only runs when the page path includes `/preview`, `/profile`, or `/hiring/.../apply/`. The override mechanism (HTMLAnchorElement.prototype.click, window.open) is unchanged; only the conditions under which they block are tightened.
- **Safe because:** Automation logic (extLoggedIn, shouldBlockNow, isResumeApi, isTargetApi) is unchanged. We only added early-exit guards to reduce unnecessary work and scope blocking to relevant pages.

### 3. inject.js removal
- **Verification:** Manifest references `js/inject_naukri.js` and `nexusPage.js` (web_accessible_resource). No manifest entry, content script, or import references `inject.js`.
- **Build:** `scripts/build.js` copies all public root files; `nexusPage.js` is required. `inject.js` was never in the required-files list.
- **Obfuscate:** `scripts/obfuscate.js` listed `inject.js` as "legacy name still present in repo (not referenced by manifest)".
- **Safe because:** `inject.js` was a near-duplicate of `nexusPage.js` and was never loaded at runtime. Removal has no effect on extension behavior.

---

## SECTION C — Confirmation That Programmatic Click Automation Still Works

| Override | Status | Notes |
|----------|--------|------|
| `HTMLAnchorElement.prototype.click` | ✅ Preserved | Still blocks blob/download anchors only when `shouldBlockNow()` and `isRelevantPageForDownloadBlock()` are true. Programmatic `button.click()` and normal anchor clicks pass through. |
| `window.open` | ✅ Preserved | Still blocks blob URLs only when `shouldBlockNow()` and `isRelevantPageForDownloadBlock()` are true. Normal `window.open` calls pass through. |
| `window.fetch` | ✅ Preserved | Override intact. Early return when URL is not relevant avoids extra work but does not change interception of resume/contact/candidate APIs. |
| `window.XMLHttpRequest` | ✅ Preserved | Override intact. Same early-return scoping as fetch. |

**Automation flow unchanged:**
- `extLoggedIn` (from EXT_AUTH_STATE) still gates all interception.
- `scheduleResdexViewPhoneAutoClick()` / `scheduleHiringContactAutoClick()` still programmatically click "View phone number" / "Contact" buttons.
- `autoClickDownloadCvButton()` still programmatically clicks "Download CV" when applicable.
- `installCvDownloadBlocker()` still installs anchor/open overrides when Download CV is auto-clicked.
- `triggerNaukriResumeDownloadIfPossible` / `triggerNaukriHiringResumeDownloadIfPossible` still trigger resume downloads via XHR.
- API_INTERCEPTOR messages still flow from page → content script → background.

---

## SECTION D — Potential Side Effects

1. **postMessage targetOrigin:** If any listener runs in an iframe or different-origin context, it would no longer receive these messages. Current architecture uses same-window messaging; no iframe listeners were found. **Risk: Low.**

2. **Scoped fetch/XHR:** Requests to unrelated APIs (e.g. analytics, CDN) are no longer cloned or parsed. This reduces CPU/memory usage. **Risk: None.**

3. **Scoped anchor/open blocking:** If a future flow needs to block blob downloads on a page that does not match `/preview`, `/profile`, or `/hiring/.../apply/`, it would not be blocked. Current flows only use the blocker on preview/profile/hiring pages. **Risk: Low.**

4. **inject.js removal:** Any external reference (e.g. documentation, flow.tldr) to `inject.js` would be stale. `flow.tldr` contains references; consider updating if that file is used. **Risk: Low.**

---

## Host Permissions Report (Manifest Validation)

| Permission | Used in Code | Notes |
|------------|--------------|-------|
| `*://naukri.com/*` | ✅ Yes | contentScript, nexusPage, background |
| `*://*.naukri.com/*` | ✅ Yes | resdex.naukri.com, hiring.naukri.com, etc. |
| `*://naukrigulf.com/*` | ❌ No | Not referenced in codebase |
| `*://*.naukrigulf.com/*` | ❌ No | Not referenced in codebase |
| `*://shine.com/*` | ✅ Yes | Shine content scripts, extractor, tools |
| `*://*.shine.com/*` | ✅ Yes | recruiter.shine.com |

**Finding:** `naukrigulf.com` permissions are not used in the current codebase. They may be intended for Naukri Gulf or future features. **No automatic removal recommended** — only report as above.

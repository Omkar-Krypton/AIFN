import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";

function DuplicateExtensionWarning() {
  return (
    <div
      style={{
        padding: 20,
        fontSize: 14,
        color: "#b00020",
        fontWeight: "bold",
      }}
    >
      ⚠ Another version of this extension is already installed.
      <br />
      <br />
      Please remove the older one first to use the latest version.
    </div>
  );
}

function NaukriConflictWarning({ extensions }) {
  const list = extensions && extensions.length > 0 ? extensions : [];
  return (
    <div
      style={{
        padding: 24,
        maxWidth: 380,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 14,
        lineHeight: 1.5,
        color: "#333",
      }}
    >
      <div
        style={{
          fontSize: 28,
          marginBottom: 12,
          textAlign: "center",
        }}
      >
        ⚠️
      </div>
      <h2
        style={{
          margin: "0 0 12px 0",
          fontSize: 18,
          fontWeight: 600,
          color: "#b00020",
          textAlign: "center",
        }}
      >
        Conflicting extension detected
      </h2>
      <p style={{ margin: "0 0 16px 0", color: "#555" }}>
        The following extension(s) also work on the Naukri platform and may cause conflicts or unexpected behaviour:
      </p>
      <ul
        style={{
          margin: "0 0 16px 0",
          paddingLeft: 20,
          color: "#333",
        }}
      >
        {list.map((ext) => (
          <li key={ext.id} style={{ marginBottom: 4 }}>
            <strong>{ext.name}</strong>
            {ext.enabled === false && " (disabled)"}
          </li>
        ))}
      </ul>
      <p style={{ margin: 0, fontWeight: 600, color: "#b00020" }}>
        Please disable or uninstall the extension(s) listed above before using this extension on Naukri.
      </p>
    </div>
  );
}

const rootEl = document.getElementById("root");
const root = createRoot(rootEl);

function renderApp() {
  root.render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
}

function renderDuplicateWarning() {
  root.render(<DuplicateExtensionWarning />);
}

function renderNaukriConflictWarning(naukriConflicts) {
  root.render(<NaukriConflictWarning extensions={naukriConflicts} />);
}

if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
  chrome.runtime.sendMessage({ action: "checkDuplicate" }, (response) => {
    if (chrome.runtime.lastError) {
      renderApp();
      return;
    }
    if (response?.conflict) {
      renderDuplicateWarning();
    } else if (response?.naukriConflicts?.length > 0) {
      renderNaukriConflictWarning(response.naukriConflicts);
    } else {
      renderApp();
    }
  });
} else {
  renderApp();
}


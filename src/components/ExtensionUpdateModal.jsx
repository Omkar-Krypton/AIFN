import { ExternalLink, RefreshCw } from "lucide-react";

const downloadUrl = import.meta.env.VITE_FRONTEND_URL || null;
const currentExtensionVersion = import.meta.env.VITE_VERSION || "Unknown";

function ExtensionUpdateModal({ onClose, newVersion }) {
  const handleUpdateClick = () => {
    if (!downloadUrl) return;
    window.open(downloadUrl, "_blank");
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-lg p-4 w-full max-w-[350px] mx-2">
        <h2 className="text-xl font-semibold text-left text-gray-800 mb-6">
          Extension Update Available
        </h2>

        <div className="bg-blue-50 border border-blue-200 text-blue-800 rounded-md p-4 mb-4 shadow-sm">
          <div className="flex items-start gap-3 mb-4">
            <RefreshCw className="h-6 w-6 flex-shrink-0 mt-1 text-blue-600" />
            <div className="flex-1">
              <p className="text-sm leading-relaxed mb-3">
                A new version of the extension is available. Please update to get the
                latest features and improvements.
              </p>
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-gray-700">Current Version:</span>
                  <span className="text-xs text-gray-600">
                    {currentExtensionVersion || "Unknown"}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs font-medium text-gray-700">New Version:</span>
                  <span className="text-xs text-gray-600 font-semibold">
                    {newVersion || "Latest"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded border border-teal-600 text-teal-600 hover:bg-teal-100 transition cursor-pointer text-sm font-medium"
              >
                Later
              </button>
            )}
            <button
              type="button"
              onClick={handleUpdateClick}
              disabled={!downloadUrl}
              className="px-4 py-2 rounded text-white transition cursor-pointer hover:opacity-90 text-sm font-medium flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ backgroundColor: import.meta.env.VITE_PRIMARY_COLOR || "#009689" }}
            >
              Update Now
              <ExternalLink className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="mt-4 pt-3 border-t border-gray-200">
          <div className="space-y-1">
            <p className="text-[10px] text-gray-600 text-center leading-relaxed">
              Updating ensures you have access to the latest features, bug fixes, and
              security improvements.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExtensionUpdateModal;


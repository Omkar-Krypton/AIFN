const VERSION = import.meta.env.VITE_VERSION;

export const VERSION_DISPLAY = `Version ${VERSION}`;

// Keeping the same exports as Working_extension so UI can be reused.
export const BUILD_DATE = new Date().toISOString().split("T")[0];

export const getBuildDateDisplay = () => {
  const date = new Date(BUILD_DATE);
  const options = { year: "numeric", month: "short", day: "numeric" };
  return date.toLocaleDateString("en-US", options);
};

// Static release date label (matches Working_extension behavior)
export const SS_BUILD_DATE = "30-01-2025";


const DISABLED_STATE = "disabled";

function updateVersion(info, fallback) {
  const version = info?.version || info?.releaseName || fallback;
  return typeof version === "string" && version.trim() ? version : null;
}

function progressPercent(progress) {
  const percent = Number(progress?.percent);
  if (!Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Connect the Electron updater to the browser state without coupling the main
 * process to a particular update provider. The updater downloads in the
 * background and installs automatically when the app next quits.
 */
export function createUpdateController({
  updater,
  currentVersion,
  enabled = true,
  onState = () => {},
}) {
  let state = {
    status: enabled ? "idle" : DISABLED_STATE,
    currentVersion: currentVersion || null,
    version: null,
    percent: null,
    message: null,
  };

  const publish = (next) => {
    state = { ...state, ...next };
    onState({ ...state });
  };

  if (!enabled || !updater) {
    onState({ ...state });
    return {
      getState: () => ({ ...state }),
      start: async () => null,
    };
  }

  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => {
    publish({ status: "checking", message: null });
  });
  updater.on("update-available", (info) => {
    publish({
      status: "downloading",
      version: updateVersion(info, null),
      percent: 0,
      message: null,
    });
  });
  updater.on("download-progress", (progress) => {
    publish({
      status: "downloading",
      percent: progressPercent(progress),
      message: null,
    });
  });
  updater.on("update-downloaded", (info) => {
    publish({
      status: "ready",
      version: updateVersion(info, state.version),
      percent: 100,
      message: "Update ready; it will apply on the next launch.",
    });
  });
  updater.on("update-not-available", () => {
    publish({ status: "current", percent: null, message: null });
  });
  updater.on("update-cancelled", () => {
    publish({ status: "cancelled", percent: null });
  });
  updater.on("error", (error) => {
    publish({
      status: "error",
      percent: null,
      message: String(error?.message || error || "update check failed").slice(
        0,
        240,
      ),
    });
  });
  onState({ ...state });

  return {
    getState: () => ({ ...state }),
    start: async () => {
      if (typeof updater.checkForUpdatesAndNotify !== "function") {
        throw new Error("Electron updater does not support update checks");
      }
      return updater.checkForUpdatesAndNotify();
    },
  };
}

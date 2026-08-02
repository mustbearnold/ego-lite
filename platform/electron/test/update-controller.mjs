import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUpdateController } from "../update.mjs";

const updater = new EventEmitter();
updater.checkForUpdatesAndNotify = async () => ({ checked: true });
const states = [];
const controller = createUpdateController({
  updater,
  currentVersion: "1.0.0",
  onState: (state) => states.push(state),
});

assert.equal(updater.autoDownload, true);
assert.equal(updater.autoInstallOnAppQuit, true);
assert.equal(controller.getState().status, "idle");
await controller.start();

updater.emit("checking-for-update");
updater.emit("update-available", { version: "1.1.0" });
assert.equal(controller.getState().status, "downloading");
assert.equal(controller.getState().version, "1.1.0");
updater.emit("download-progress", { percent: 42.6 });
assert.equal(controller.getState().percent, 43);
updater.emit("update-downloaded", { version: "1.1.0" });
assert.equal(controller.getState().status, "ready");
assert.match(controller.getState().message, /next launch/);

const disabled = createUpdateController({
  updater: new EventEmitter(),
  currentVersion: "1.0.0",
  enabled: false,
});
assert.equal(disabled.getState().status, "disabled");
assert.ok(states.length >= 4);

console.log(
  JSON.stringify({
    configured: {
      autoDownload: updater.autoDownload,
      autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
    },
    final: controller.getState(),
    disabled: disabled.getState(),
  }),
);

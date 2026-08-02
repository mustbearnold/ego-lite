import { parentPort, workerData } from "node:worker_threads";
import { readBrowserSourceData } from "./browser-sync.mjs";

try {
  const data = await readBrowserSourceData(workerData?.profileDir);
  parentPort.postMessage({ ok: true, data });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.message || String(error),
  });
}

export async function openDownloadPath(path, openPath) {
  if (!path) throw new Error("download is not ready");
  if (typeof openPath !== "function") {
    throw new Error("download opener is unavailable");
  }
  const error = await openPath(path);
  if (error) throw new Error(String(error));
  return { opened: true, path };
}

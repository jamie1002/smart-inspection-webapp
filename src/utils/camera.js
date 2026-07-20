// 相機鏡頭設定：連續自動對焦 + 鎖定變焦 1x（0717 版策略，行為不變）
// getCapabilities 在 iOS Safari 不存在，此整段對 iOS 不生效（安全）。

export async function tryConfigureCamera(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== "function") return;

  let capabilities;
  try {
    capabilities = track.getCapabilities();
  } catch (err) {
    console.warn("無法取得相機能力資訊（可忽略）：", err);
    return;
  }

  const advanced = [];

  if (
    capabilities.zoom &&
    typeof capabilities.zoom.min === "number" &&
    typeof capabilities.zoom.max === "number" &&
    capabilities.zoom.min <= 1 &&
    capabilities.zoom.max >= 1
  ) {
    advanced.push({ zoom: 1 });
  }

  if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch (err) {
      console.warn("相機鏡頭設定失敗（可能裝置不支援，可忽略）：", err);
    }
  }
}

// navigator.share 打包分享（0717 定案，行為不變）
// 集中在四張都比對確認完後一次打包分享；不支援時降級為 MANUAL_SAVE。
// 回傳 "shared" / "cancelled" / "unsupported"

export async function trySharePhotos(photos) {
  if (!navigator.share) return "unsupported";

  try {
    const timestamp = Date.now();
    const files = await Promise.all(
      photos.map(async (photo, index) => {
        const res = await fetch(photo.dataUrl);
        const blob = await res.blob();
        return new File([blob], `car_detect_${photo.position}_${timestamp}_${index}.jpg`, {
          type: "image/jpeg",
        });
      })
    );

    if (!(navigator.canShare && navigator.canShare({ files }))) {
      return "unsupported";
    }

    await navigator.share({ files, title: "車況檢測照片" });
    return "shared";
  } catch (err) {
    if (err.name === "AbortError") {
      return "cancelled";
    }
    console.warn("分享失敗，改用長按儲存引導：", err);
    return "unsupported";
  }
}

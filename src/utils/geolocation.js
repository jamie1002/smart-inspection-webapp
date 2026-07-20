// GPS 定位（新增）
// canvas 影像不含 EXIF，無法用 exifr 讀 GPS；改用 navigator.geolocation。
// 開始檢測時請求一次權限，之後每張照片取得當下座標。
// 一律不擋流程：取不到就回傳 { lat:null, lng:null, accuracy:null, source:"none" }。

function getPositionOnce(options) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve({ lat: null, lng: null, accuracy: null, source: "none" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          source: "geolocation",
        });
      },
      (err) => {
        console.warn("定位失敗（不擋流程）：", err && err.message);
        resolve({ lat: null, lng: null, accuracy: null, source: "none" });
      },
      options
    );
  });
}

// 開始檢測時呼叫一次，觸發權限請求並暖機
export function warmUpGeolocation() {
  return getPositionOnce({ enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
}

// 每張照片拍攝時呼叫，允許使用近期快取以加速
export function getCurrentPositionSafe() {
  return getPositionOnce({ enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 });
}

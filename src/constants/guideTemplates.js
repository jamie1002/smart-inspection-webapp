// 四方位引導框座標模板與拍攝順序
// 從 CameraModule.jsx 抽出，座標一律不變
//
// ⚠️ 命名說明：本專案內部 position 沿用既有值（front_left / left_rear /
//   right_rear / right_front），但資料庫 photo_type 標準（見 04 文件）為
//   front_left / rear_left / front_right / rear_right。上傳前用
//   POSITION_TO_PHOTO_TYPE 轉換，避免後端對不上。

// 拍攝順序（沿用 0714 版定案）：左前 → 左後 → 右後 → 右前
export const POSITION_SEQUENCE = [
  "front_left",
  "left_rear",
  "right_rear",
  "right_front",
];

// 內部 position → 資料庫標準 photo_type
export const POSITION_TO_PHOTO_TYPE = {
  front_left: "front_left",
  left_rear: "rear_left",
  right_rear: "rear_right",
  right_front: "front_right",
};

export const GUIDE_TEMPLATES = {
  front_left: {
    label: "左前",
    licensePlate: { xMin: 7.4, xMax: 18.7, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 63.3, xMax: 77.9, yMin: 49.6, yMax: 64.4 },
  },
  left_rear: {
    label: "左後",
    licensePlate: { xMin: 77.2, xMax: 88.4, yMin: 50.9, yMax: 56.2 },
    wheel: { xMin: 20.7, xMax: 36.5, yMin: 56.1, yMax: 70.6 },
  },
  right_rear: {
    label: "右後",
    licensePlate: { xMin: 11.6, xMax: 22.8, yMin: 50.9, yMax: 56.2 },
    wheel: { xMin: 63.5, xMax: 79.3, yMin: 56.1, yMax: 70.6 },
  },
  right_front: {
    label: "右前",
    licensePlate: { xMin: 81.3, xMax: 92.6, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 22.1, xMax: 36.7, yMin: 49.6, yMax: 64.4 },
  },
};

export function keyToTemplateField(key) {
  return key === "license_plate" ? "licensePlate" : "wheel";
}

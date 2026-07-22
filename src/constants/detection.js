// 模型、偵測門檻、影像處理與流程計時相關常數
// 從 CameraModule.jsx 抽出，數值一律不變

// ============================================
// 車體定位模型（license_plate / wheel）
// ============================================
export const MODEL_URL = `${import.meta.env.BASE_URL}model/model.json`;
export const CLASS_NAMES = ["license_plate", "wheel"];
export const CONFIDENCE_THRESHOLD = 0.25;
export const INFERENCE_INTERVAL_MS = 150;
export const POSITION_TOLERANCE_PERCENT = 20;
export const AREA_TOLERANCE_RATIO = 0.2;

// ============================================
// 車牌字元辨識模型（33 類）
// ============================================
export const CHAR_MODEL_URL = `${import.meta.env.BASE_URL}model_char/model.json`;
export const CHAR_CLASS_NAMES = [
  "0", "1", "2", "3", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L",
  "M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
];
export const CHAR_CONFIDENCE_THRESHOLD = 0.6;
export const CHAR_NMS_IOU_THRESHOLD = 0.3;
export const CHAR_CROP_PADDING_PERCENT = 20;
// 車牌裁切最小外擴（單位：畫面寬/高的百分點，非框自身比例）。
// 原因：9:16 因裁切高度較大，車體定位模型前處理需把畫面等比縮進固定 640×640，
// 縮放係數 = 640/max(cropW,cropH) 明顯小於 3:4，車牌在偵測輸入影像中的實際像素變小、
// 偵測框容易偏窄（右側字元被切掉），若只用「框自身寬高的 10%」外擴，框越窄補的越少，
// 無法補回被切掉的字元；改用「畫面百分比」的最小外擴，與框準確度無關，能穩定補足缺口。
export const CHAR_CROP_MIN_PADDING_PCT = 3;
export const CHAR_INPUT_SIZE = 640;

// 模型輸入前處理正方形尺寸（車體定位）
export const DETECTION_INPUT_SIZE = 640;

// ============================================
// 方向鎖（陀螺儀）
// ============================================
export const GAMMA_THRESHOLD = 25;
export const BETA_MIN = 60;
export const BETA_MAX = 95;
export const ORIENTATION_THROTTLE_MS = 150;
export const ORIENTATION_STABLE_SAMPLES = 1;

// ============================================
// 畫質檢驗（模糊偵測）
// ============================================
export const LIVE_BLUR_CHECK_INTERVAL_MS = 200;
export const LIVE_BLUR_SAMPLE_WIDTH = 160;
export const LIVE_BLUR_STABLE_SAMPLES = 2;
export const BLUR_BASELINE_MIN_SAMPLES = 4;
export const BLUR_BASELINE_EMA_ALPHA = 0.15;
export const BLUR_RELATIVE_RATIO = 0.5;

// ============================================
// 位置/距離提示方向符號（實機校正值）
// ============================================
export const HORIZONTAL_HINT_SIGN = -1;
export const VERTICAL_HINT_SIGN = -1;

// ============================================
// 存檔輸出與顯示裁切
// ============================================
export const MAX_OUTPUT_LONG_EDGE = 1920;
export const DISPLAY_CROP_RATIO = 9 / 16;

// ============================================
// 自動快門與流程計時
// ============================================
export const CAPTURE_STABLE_DURATION_MS = 1000;
export const ANALYZING_DURATION_MS = 2000;

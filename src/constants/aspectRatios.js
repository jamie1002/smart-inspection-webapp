// 取景／裁切／顯示比例登錄表
// 正式版固定 3:4（無切換 UI）；測試版可於首頁選單切換比較，預設值同為 3:4。
// 影響範圍：Viewfinder 取景框顯示比例、GuideOverlay 引導線稿 viewBox、
//   拍照輸出裁切（utils/geometry.computeDisplayCropGeometry 的 cropRatio）、
//   模型輸入前處理裁切（services/models.js 需與輸出裁切一致，偵測座標才會準）。
//
// 新增比例時：於下方登錄一筆，並到 constants/carModels.js 補上該比例對應的
// templates / outlines / ghost（可用 scripts/build_guides.py --ratio <key> 產生線稿與 ghost）。
export const ASPECT_RATIOS = {
    "3:4": {
        key: "3:4",
        label: "3:4",
        w: 3,
        h: 4,
        ratio: 3 / 4, // 寬/高，供 computeDisplayCropGeometry 使用
        viewBox: { w: 720, h: 960 }, // GuideOverlay SVG viewBox，需與此比例同步
    },
    "9:16": {
        key: "9:16",
        label: "9:16",
        w: 9,
        h: 16,
        ratio: 9 / 16,
        viewBox: { w: 720, h: 1280 },
    },
};

export const ASPECT_RATIO_LIST = Object.keys(ASPECT_RATIOS); // ["3:4", "9:16"]

// 正式版固定值；測試版初始值亦同，測試版可於首頁切換至清單內其他比例比對。
export const DEFAULT_ASPECT_RATIO = "3:4";
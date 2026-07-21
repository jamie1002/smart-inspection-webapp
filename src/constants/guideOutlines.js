// 取景引導「共用設定」
// ⚠️ 各車款的線稿（車身/車牌/車輪路徑）已改放 constants/guides/<slug>.js，
//    由 scripts/build_guides.py 依 Roboflow COCO 標註產生；此檔只留跨車款共用設定。
export const GUIDE_VIEWBOX = { w: 720, h: 1280 };

// 車身呈現風格：'ghost'（半透明實車 + 外框線稿，預設）| 'line'（只有外框線稿）
export const GUIDE_CAR_STYLE = "ghost";
export const GHOST_OPACITY = 0.15;

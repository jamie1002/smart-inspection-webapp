// 版本切換唯一判定來源（做法一：build --mode 建置旗標 + ?test 網址覆寫）
// 其他檔案一律 import IS_TEST_MODE，不自行讀 env 或網址。
//
// 兩層機制：
// 1) 建置層（主要）：由 build 指令的 --mode 決定，Vite 會把 import.meta.env.MODE
//    靜態替換為字面值。`npm run build:test`（--mode test）→ MODE === "test"；
//    `npm run build`（預設）→ MODE === "production"。正式版 if(IS_TEST_MODE){...}
//    變成 if(false) 被 tree-shaking 移除，測試專屬元件（DetectionOverlay /
//    DebugPanel / 手動快門 / 校正工具）在正式 bundle 中完全不存在。
//    ⚠️ 採用 Vite 內建的 import.meta.env.MODE，不需自訂 .env.test（遠端工具亦禁寫 dotenv）。
// 2) 執行層（次要）：?test 網址參數，僅在含測試碼的 build（dev）上臨時切換。
//    正式 build 已移除除錯碼，?test 無法叫回，屬刻意設計。

const IS_TEST_BUILD = import.meta.env.MODE === "test";

let hasTestParam = false;
try {
  hasTestParam = new URLSearchParams(window.location.search).has("test");
} catch {
  hasTestParam = false;
}

export const IS_TEST_MODE = IS_TEST_BUILD || (import.meta.env.DEV && hasTestParam);
export const APP_MODE = IS_TEST_MODE ? "test" : "prod";
export const APP_VERSION = "1.0.0-refactor";

// 模型版本標記（寫入 Firestore，方便日後對應資料）
export const MODEL_VERSION = { car: "yolov8n-2cls", char: "yolov8n-33cls" };

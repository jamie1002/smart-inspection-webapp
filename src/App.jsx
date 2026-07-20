import { useState } from "react";
import CameraFlow from "./components/CameraFlow";
import CameraCalibrationView from "./components/CameraCalibrationView";
import { IS_TEST_MODE } from "./config/appConfig";

function App() {
  // 校正工具僅測試版可達：網址加 ?debug（且需為測試版建置）
  // 例如：https://<host>/smart-inspection-webapp/?debug
  const [showCalibration] = useState(() => {
    if (!IS_TEST_MODE) return false;
    try {
      return new URLSearchParams(window.location.search).has("debug");
    } catch {
      return false;
    }
  });

  return showCalibration ? <CameraCalibrationView /> : <CameraFlow />;
}

export default App;

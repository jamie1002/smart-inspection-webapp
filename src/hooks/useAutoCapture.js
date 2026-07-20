// 自動快門：canAutoCapture 持續穩定達門檻時間即觸發拍照
// 行為沿用 CameraModule 的穩定計時邏輯不變。
import { useState, useRef, useEffect } from "react";
import { CAMERA_STATUS, FLOW_STAGE } from "../constants/flow";
import { CAPTURE_STABLE_DURATION_MS } from "../constants/detection";

export function useAutoCapture({ status, stage, canAutoCapture, onCapture }) {
  const [stableCountdownActive, setStableCountdownActive] = useState(false);
  const canAutoCaptureRef = useRef(false);
  const stableSinceRef = useRef(null);
  const onCaptureRef = useRef(onCapture);

  useEffect(() => {
    canAutoCaptureRef.current = canAutoCapture;
  }, [canAutoCapture]);

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || stage !== FLOW_STAGE.SHOOTING) {
      stableSinceRef.current = null;
      setStableCountdownActive(false);
      return;
    }

    const timerId = setInterval(() => {
      if (!canAutoCaptureRef.current) {
        stableSinceRef.current = null;
        setStableCountdownActive(false);
        return;
      }
      if (stableSinceRef.current === null) {
        stableSinceRef.current = Date.now();
      }
      const elapsed = Date.now() - stableSinceRef.current;
      if (elapsed >= CAPTURE_STABLE_DURATION_MS) {
        stableSinceRef.current = null;
        setStableCountdownActive(false);
        onCaptureRef.current?.();
      } else {
        setStableCountdownActive(true);
      }
    }, 100);

    return () => clearInterval(timerId);
  }, [status, stage]);

  return { stableCountdownActive };
}

// 相機生命週期：權限（相機 + 方向感測器）、串流、狀態機、session、GPS 暖機
import { useState, useRef, useEffect, useCallback } from "react";
import { CAMERA_STATUS } from "../constants/flow";
import { tryConfigureCamera } from "../utils/camera";
import { generateSessionId } from "../utils/session";
import { warmUpGeolocation } from "../utils/geolocation";

const ORIENTATION_DENIED_MSG =
  "需要方向感測器權限才能使用檢測功能。\n\n若您先前已拒絕，系統將不會再次跳出授權視窗，請至「設定 > Safari > 動作與方向存取」開啟後，重新整理頁面再試一次。";

export function useCamera() {
  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const sessionIdRef = useRef(null);
  const gpsRef = useRef({ lat: null, lng: null, accuracy: null, source: "none" });

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.onended = null; // 主動停止不應觸發下方的意外中斷處理
        track.stop();
      });
      streamRef.current = null;
    }
  }, []);

  // 相機串流被瀏覽器/系統意外中止時（非我方呼叫 stopStream 所致，例如過熱、
  // 記憶體壓力、鏡頭被其他程式搶走），track 會觸發 'ended'。
  // 若不處理，video 元素會停在最後一格畫面（一片黑或凍結），且永遠無法恢復，
  // 使用者只能重新整理頁面。這裡偵測到中斷後清空串流參考、切回 ERROR 狀態，
  // 讓既有的「重新嘗試」畫面可以重新呼叫 requestCamera()。
  const attachEndedHandler = useCallback((stream) => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    track.onended = () => {
      console.error("相機串流意外中斷（可能為過熱或系統資源限制），需重新授權才能恢復");
      if (streamRef.current === stream) streamRef.current = null;
      setStatus(CAMERA_STATUS.ERROR);
    };
  }, []);

  const requestCamera = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(CAMERA_STATUS.UNSUPPORTED);
      return;
    }

    setStatus(CAMERA_STATUS.REQUESTING);

    // iOS：方向感測器權限須在使用者手勢堆疊內請求
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      try {
        const permissionResult = await DeviceOrientationEvent.requestPermission();
        if (permissionResult !== "granted") {
          alert(ORIENTATION_DENIED_MSG);
          setStatus(CAMERA_STATUS.IDLE);
          return;
        }
      } catch (err) {
        console.error("方向感測器授權請求失敗：", err);
        alert(ORIENTATION_DENIED_MSG);
        setStatus(CAMERA_STATUS.IDLE);
        return;
      }
    }

    const constraints = {
      video: { facingMode: "environment", width: { ideal: 6000 }, height: { ideal: 6000 } },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      attachEndedHandler(stream);
      await tryConfigureCamera(stream);
      if (!sessionIdRef.current) sessionIdRef.current = generateSessionId();
      // GPS 暖機（請求定位權限，不擋流程）
      warmUpGeolocation().then((pos) => { gpsRef.current = pos; }).catch(() => {});
      setStatus(CAMERA_STATUS.GRANTED);
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setStatus(CAMERA_STATUS.DENIED);
      } else {
        setStatus(CAMERA_STATUS.ERROR);
      }
      console.error("相機授權失敗：", err);
    }
  }, []);

  useEffect(() => () => stopStream(), [stopStream]);

  return { status, setStatus, videoRef, streamRef, sessionIdRef, gpsRef, requestCamera, stopStream };
}

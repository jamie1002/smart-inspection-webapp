// 三宮格相機校正工具（原 CameraDebugView 改名）
// ⚠️ 測試版限定：僅在 IS_TEST_MODE && ?debug 時由 App 掛載。
// 共用 utils/geometry 的 computeDisplayCropGeometry，不再自行複製（消除同步風險）。
import { useState, useRef, useEffect, useCallback } from "react";
import { CAMERA_STATUS } from "../constants/flow";
import { computeDisplayCropGeometry } from "../utils/geometry";
import { colors } from "../styles/theme";

const DRAW_INTERVAL_MS = 150;

export default function CameraCalibrationView() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelInputCanvasRef = useRef(null);
  const rawFrameCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [rawSize, setRawSize] = useState({ w: 0, h: 0 });

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const requestCamera = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(CAMERA_STATUS.UNSUPPORTED);
      return;
    }
    setStatus(CAMERA_STATUS.REQUESTING);
    const constraints = {
      video: { facingMode: "environment", width: { ideal: 6000 }, height: { ideal: 6000 } },
      audio: false,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setStatus(CAMERA_STATUS.GRANTED);
    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") setStatus(CAMERA_STATUS.DENIED);
      else setStatus(CAMERA_STATUS.ERROR);
      console.error("相機授權失敗：", err);
    }
  }, []);

  useEffect(() => {
    if (status === CAMERA_STATUS.GRANTED && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  useEffect(() => () => stopStream(), [stopStream]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED) return;

    const drawDebugFrames = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      const rawW = video.videoWidth;
      const rawH = video.videoHeight;
      if (!rawW || !rawH) return;
      setRawSize({ w: rawW, h: rawH });

      const modelCanvas = modelInputCanvasRef.current;
      if (modelCanvas) {
        const { cropW, cropH } = computeDisplayCropGeometry(rawW, rawH);
        const scale = 640 / Math.max(cropW, cropH);
        const newW = Math.round(cropW * scale);
        const newH = Math.round(cropH * scale);
        const padLeft = Math.floor((640 - newW) / 2);
        const padTop = Math.floor((640 - newH) / 2);
        const ctx = modelCanvas.getContext("2d");
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 640, 640);
        ctx.save();
        ctx.beginPath();
        ctx.rect(padLeft, padTop, newW, newH);
        ctx.clip();
        ctx.translate(320, 320);
        ctx.scale(scale, scale);
        ctx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);
        ctx.restore();
      }

      const rawCanvas = rawFrameCanvasRef.current;
      if (rawCanvas) {
        const size = rawCanvas.width;
        const scale = Math.min(size / rawW, size / rawH);
        const drawW = rawW * scale;
        const drawH = rawH * scale;
        const offsetX = (size - drawW) / 2;
        const offsetY = (size - drawH) / 2;
        const ctx = rawCanvas.getContext("2d");
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(video, 0, 0, rawW, rawH, offsetX, offsetY, drawW, drawH);
      }
    };

    intervalRef.current = setInterval(drawDebugFrames, DRAW_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [status]);

  return (
    <div style={styles.page}>
      {status === CAMERA_STATUS.IDLE && (
        <div style={styles.center}>
          <button style={styles.startBtn} onClick={requestCamera}>開始除錯檢視</button>
        </div>
      )}
      {status === CAMERA_STATUS.REQUESTING && <div style={styles.center}><p>正在請求相機權限…</p></div>}
      {status === CAMERA_STATUS.DENIED && <div style={styles.center}><p style={styles.err}>需要相機權限</p></div>}
      {status === CAMERA_STATUS.UNSUPPORTED && <div style={styles.center}><p style={styles.err}>不支援相機功能</p></div>}
      {status === CAMERA_STATUS.ERROR && <div style={styles.center}><p style={styles.err}>初始化發生錯誤</p></div>}

      {status === CAMERA_STATUS.GRANTED && (
        <div style={styles.layout}>
          <div style={styles.viewfinderWrap}>
            <p style={styles.label}>① 正式畫面邏輯（9:16，object-fit: cover 置中裁切）</p>
            <div style={styles.viewfinder}>
              <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
            </div>
          </div>
          <div style={styles.squareRow}>
            <div style={styles.squareItem}>
              <p style={styles.label}>② 模型輸入前處理（9:16 裁切→640，無旋轉修正）</p>
              <canvas ref={modelInputCanvasRef} width={640} height={640} style={styles.squareCanvas} />
            </div>
            <div style={styles.squareItem}>
              <p style={styles.label}>③ 感測器原始畫面（無裁切、無旋轉修正）</p>
              <canvas ref={rawFrameCanvasRef} width={320} height={320} style={styles.squareCanvas} />
            </div>
          </div>
          <p style={styles.rawText}>感測器回報原始尺寸：{rawSize.w} × {rawSize.h}</p>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { width: "100vw", minHeight: "100dvh", display: "flex", justifyContent: "center", alignItems: "center", backgroundColor: colors.bg },
  center: { color: "#fff", textAlign: "center", padding: 24 },
  startBtn: { padding: "16px 32px", fontSize: 18, borderRadius: 8, border: "none", backgroundColor: colors.brand, color: "#fff", fontWeight: 700, cursor: "pointer" },
  err: { color: colors.danger, fontSize: 16 },
  layout: { width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 16, boxSizing: "border-box" },
  viewfinderWrap: { display: "flex", flexDirection: "column", alignItems: "center" },
  label: { color: "#fff", fontSize: 13, marginBottom: 6, textAlign: "center" },
  viewfinder: { width: 260, aspectRatio: "9 / 16", backgroundColor: "#111", overflow: "hidden" },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  squareRow: { display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" },
  squareItem: { display: "flex", flexDirection: "column", alignItems: "center" },
  squareCanvas: { width: 160, height: 160, backgroundColor: "#111", border: "1px solid #333" },
  rawText: { color: colors.textSecondary, fontSize: 13 },
};

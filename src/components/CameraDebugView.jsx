import { useState, useRef, useEffect, useCallback } from "react";

const CAMERA_STATUS = {
  IDLE: "idle",
  REQUESTING: "requesting",
  GRANTED: "granted",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
};

const DRAW_INTERVAL_MS = 150;

// 🔧 與 CameraModule.jsx 完全同步：模型輸入與拍照存檔共用的裁切比例（= APP 顯示畫面比例）
const DISPLAY_CROP_RATIO = 9 / 16;

// 🔧 與 CameraModule.jsx 的 computeDisplayCropGeometry() 完全同步，
// 若正式功能那邊之後有調整，記得同步更新這裡，否則除錯畫面會失真
function computeDisplayCropGeometry(rawW, rawH) {
  const isLandscapeFeed = rawW > rawH;
  const logicalW = isLandscapeFeed ? rawH : rawW;
  const logicalH = isLandscapeFeed ? rawW : rawH;

  let cropW = logicalW;
  let cropH = logicalH;
  const currentRatio = logicalW / logicalH;

  if (currentRatio > DISPLAY_CROP_RATIO) {
    cropW = logicalH * DISPLAY_CROP_RATIO;
  } else {
    cropH = logicalW / DISPLAY_CROP_RATIO;
  }

  return { isLandscapeFeed, cropW, cropH };
}

export default function CameraDebugView() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelInputCanvasRef = useRef(null);
  const rawFrameCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [rawSize, setRawSize] = useState({ w: 0, h: 0 });

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
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
      video: {
        facingMode: "environment",
        width: { ideal: 6000 },
        height: { ideal: 6000 },
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
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

  useEffect(() => {
    if (status === CAMERA_STATUS.GRANTED && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  // 每隔一段時間，把 video 畫面畫進兩個除錯用正方形 canvas
  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED) return;

    const drawDebugFrames = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const rawW = video.videoWidth;
      const rawH = video.videoHeight;
      if (!rawW || !rawH) return;

      setRawSize({ w: rawW, h: rawH });

      // ============================================
      // 正方形視窗 1：模型輸入前處理畫面
      // 🔧 完全比照 CameraModule.jsx 的 runInference() 前處理邏輯：
      // 先裁切成 9:16（= APP 顯示畫面），旋轉修正，再等比縮放到 640 置中補黑邊
      // ============================================
      const modelCanvas = modelInputCanvasRef.current;
      if (modelCanvas) {
        const { isLandscapeFeed, cropW, cropH } = computeDisplayCropGeometry(rawW, rawH);

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
        if (isLandscapeFeed) {
          ctx.rotate(Math.PI / 2);
        }
        ctx.scale(scale, scale);
        ctx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);

        ctx.restore();
      }

      // ============================================
      // 正方形視窗 2：感測器原始畫面
      // 不做任何旋轉修正、不裁切，等比縮放到「完整塞進正方形」後置中補黑邊
      // 用來確認感光元件實際回報的原始長寬與方向
      // ============================================
      const rawCanvas = rawFrameCanvasRef.current;
      if (rawCanvas) {
        const size = rawCanvas.width; // 正方形，width === height
        const scale = Math.min(size / rawW, size / rawH); // contain，不裁切
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
    <div style={styles.pageWrapper}>
      {status === CAMERA_STATUS.IDLE && (
        <div style={styles.centerScreen}>
          <button style={styles.startButton} onClick={requestCamera}>開始除錯檢視</button>
        </div>
      )}

      {status === CAMERA_STATUS.REQUESTING && <div style={styles.centerScreen}><p>正在請求相機權限...</p></div>}
      {status === CAMERA_STATUS.DENIED && <div style={styles.centerScreen}><p style={styles.errorText}>需要相機權限</p></div>}
      {status === CAMERA_STATUS.UNSUPPORTED && <div style={styles.centerScreen}><p style={styles.errorText}>不支援相機功能</p></div>}
      {status === CAMERA_STATUS.ERROR && <div style={styles.centerScreen}><p style={styles.errorText}>初始化發生錯誤</p></div>}

      {status === CAMERA_STATUS.GRANTED && (
        <div style={styles.debugLayout}>

          <div style={styles.mainViewfinderWrapper}>
            <p style={styles.label}>① 目前正式畫面邏輯（9:16，object-fit: cover 置中裁切）</p>
            <div style={styles.viewfinder}>
              <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
            </div>
          </div>

          <div style={styles.squareRow}>
            <div style={styles.squareItem}>
              <p style={styles.label}>② 模型輸入前處理畫面（9:16 裁切 + 旋轉修正後縮放到 640×640）</p>
              <canvas ref={modelInputCanvasRef} width={640} height={640} style={styles.squareCanvas} />
            </div>

            <div style={styles.squareItem}>
              <p style={styles.label}>③ 感測器原始畫面（無裁切、無旋轉修正，等比縮放補黑邊）</p>
              <canvas ref={rawFrameCanvasRef} width={320} height={320} style={styles.squareCanvas} />
            </div>
          </div>

          <p style={styles.rawSizeText}>感測器回報原始尺寸：{rawSize.w} × {rawSize.h}</p>
        </div>
      )}
    </div>
  );
}

const styles = {
  pageWrapper: {
    width: "100vw",
    minHeight: "100dvh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  centerScreen: {
    color: "#fff",
    textAlign: "center",
    padding: "24px",
  },
  startButton: {
    padding: "16px 32px",
    fontSize: "18px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "#00ff88",
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
  },
  errorText: {
    color: "#ff6666",
    fontSize: "16px",
  },
  debugLayout: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
    padding: "16px",
  },
  label: {
    color: "#fff",
    fontSize: "13px",
    marginBottom: "6px",
    textAlign: "center",
  },
  mainViewfinderWrapper: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  viewfinder: {
    width: "260px",
    aspectRatio: "9 / 16",
    backgroundColor: "#111",
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  squareRow: {
    display: "flex",
    gap: "16px",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  squareItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  squareCanvas: {
    width: "160px",
    height: "160px",
    backgroundColor: "#111",
    border: "1px solid #333",
  },
  rawSizeText: {
    color: "#aaa",
    fontSize: "13px",
  },
};
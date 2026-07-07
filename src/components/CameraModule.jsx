import { useState, useRef, useEffect, useCallback } from "react";
import * as tf from "@tensorflow/tfjs";

// ============================================
// 模型與偵測相關設定
// ============================================
const MODEL_URL = `${import.meta.env.BASE_URL}model/model.json`;

// 類別順序務必與 Roboflow data.yaml 的 names 順序完全一致
const CLASS_NAMES = ["license_plate", "wheel"];

const CONFIDENCE_THRESHOLD = 0.25; // 低於此分數的候選框直接忽略
const INFERENCE_INTERVAL_MS = 150; // 節流頻率，約 6~7 FPS
const POSITION_TOLERANCE_PERCENT = 5; // 中心點位置容許誤差（暫定值，可依實測調整）
const AREA_TOLERANCE_RATIO = 0.1; // 面積容錯率 10%

// ============================================
// 設定檔區塊：內層引導方格的百分比座標
// ============================================
const GUIDE_TEMPLATES = {
  front_left: {
    label: "左前",
    licensePlate: { xMin: 7.4, xMax: 18.7, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 63.3, xMax: 77.9, yMin: 49.6, yMax: 64.4 },
  },
};

// 相機權限與初始化的狀態機
const CAMERA_STATUS = {
  IDLE: "idle",
  REQUESTING: "requesting",
  GRANTED: "granted",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
};

// key（如 "license_plate"）對應到 GUIDE_TEMPLATES 裡的欄位名稱（如 "licensePlate"）
function keyToTemplateField(key) {
  return key === "license_plate" ? "licensePlate" : "wheel";
}

// 判斷每個偵測到的物件是否對準目標
function evaluateAlignment(rawResults, position) {
  const template = GUIDE_TEMPLATES[position];
  const evaluated = {};

  for (const key of Object.keys(rawResults)) {
    const det = rawResults[key];
    const target = template[keyToTemplateField(key)];
    if (!target) {
      evaluated[key] = { ...det, aligned: false };
      continue;
    }

    const detCenterX = (det.xMinPct + det.xMaxPct) / 2;
    const detCenterY = (det.yMinPct + det.yMaxPct) / 2;
    const targetCenterX = (target.xMin + target.xMax) / 2;
    const targetCenterY = (target.yMin + target.yMax) / 2;

    const positionOk =
      Math.abs(detCenterX - targetCenterX) <= POSITION_TOLERANCE_PERCENT &&
      Math.abs(detCenterY - targetCenterY) <= POSITION_TOLERANCE_PERCENT;

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;

    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    evaluated[key] = { ...det, aligned: positionOk && areaOk };
  }

  return evaluated;
}

export default function CameraModule() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelRef = useRef(null);
  const inputCanvasRef = useRef(null); // 隱藏的 640x640 前處理畫布
  const intervalRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [aspectRatio, setAspectRatio] = useState(9 / 16);
  const [currentPosition] = useState("front_left");
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [detections, setDetections] = useState({});

  // 清除相機串流的共用函式
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
        facingMode: { ideal: "environment" },
        aspectRatio: { ideal: 0.5625 }, // 9:16 直式
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      if (settings.aspectRatio) {
        setAspectRatio(settings.aspectRatio);
      } else if (settings.width && settings.height) {
        setAspectRatio(settings.width / settings.height);
      }

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

  // 串流接上 <video> 元素
  useEffect(() => {
    if (status === CAMERA_STATUS.GRANTED && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  // 元件卸載時關閉相機串流
  useEffect(() => {
    return () => {
      stopStream();
    };
  }, [stopStream]);

  // 載入模型（只執行一次）
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const model = await tf.loadGraphModel(MODEL_URL);
        if (!cancelled) {
          modelRef.current = model;
          setModelReady(true);
        }
      } catch (err) {
        console.error("模型載入失敗：", err);
        if (!cancelled) setModelError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // 執行單次推論
  const runInference = useCallback(() => {
    const video = videoRef.current;
    const model = modelRef.current;
    const canvas = inputCanvasRef.current;

    if (!video || !model || !canvas || video.readyState < 2) return;

    const origW = video.videoWidth;
    const origH = video.videoHeight;
    if (!origW || !origH) return;

    // 等比縮放＋補黑邊參數（與 Roboflow Fit black edges 邏輯一致）
    const scale = 640 / Math.max(origW, origH);
    const newW = Math.round(origW * scale);
    const newH = Math.round(origH * scale);
    const padLeft = Math.floor((640 - newW) / 2);
    const padTop = Math.floor((640 - newH) / 2);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 640, 640);
    ctx.drawImage(video, 0, 0, origW, origH, padLeft, padTop, newW, newH);

    tf.tidy(() => {
      const inputTensor = tf.browser
        .fromPixels(canvas)
        .toFloat()
        .div(255.0)
        .expandDims(0); // [1, 640, 640, 3]

      const output = model.execute(inputTensor); // [1, 6, 8400]
      const parsed = output.squeeze([0]).transpose([1, 0]); // [8400, 6]
      const data = parsed.arraySync();

      const rawResults = {};

      for (let classId = 0; classId < CLASS_NAMES.length; classId++) {
        let best = null;

        for (let i = 0; i < data.length; i++) {
          const conf = data[i][4 + classId];
          if (conf > CONFIDENCE_THRESHOLD && (!best || conf > best.conf)) {
            best = {
              conf,
              cx: data[i][0],
              cy: data[i][1],
              w: data[i][2],
              h: data[i][3],
            };
          }
        }

        if (best) {
          // cxcywh -> x1y1x2y2（640 補邊畫布座標）
          const x1 = best.cx - best.w / 2;
          const y1 = best.cy - best.h / 2;
          const x2 = best.cx + best.w / 2;
          const y2 = best.cy + best.h / 2;

          // 扣除黑邊偏移、還原回原始 video 畫面座標
          const realX1 = (x1 - padLeft) / scale;
          const realY1 = (y1 - padTop) / scale;
          const realX2 = (x2 - padLeft) / scale;
          const realY2 = (y2 - padTop) / scale;

          rawResults[CLASS_NAMES[classId]] = {
            conf: best.conf,
            xMinPct: (realX1 / origW) * 100,
            xMaxPct: (realX2 / origW) * 100,
            yMinPct: (realY1 / origH) * 100,
            yMaxPct: (realY2 / origH) * 100,
          };
        }
      }

      setDetections(evaluateAlignment(rawResults, currentPosition));
    });
  }, [currentPosition]);

  // 推論迴圈：只在相機開啟且模型就緒時啟動
  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || !modelReady) return;

    intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);

    return () => {
      clearInterval(intervalRef.current);
    };
  }, [status, modelReady, runInference]);

  const template = GUIDE_TEMPLATES[currentPosition];

  return (
    <div style={styles.pageWrapper}>
      {/* 隱藏的前處理畫布，不需要顯示在畫面上 */}
      <canvas ref={inputCanvasRef} width={640} height={640} style={styles.hiddenCanvas} />

      {status === CAMERA_STATUS.IDLE && (
        <div style={styles.centerScreen}>
          <button style={styles.startButton} onClick={requestCamera}>
            開始檢測車況
          </button>
        </div>
      )}

      {status === CAMERA_STATUS.REQUESTING && (
        <div style={styles.centerScreen}>
          <p>正在請求相機權限，請於瀏覽器彈出視窗中允許存取...</p>
        </div>
      )}

      {status === CAMERA_STATUS.DENIED && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>需要相機權限才能進行檢測</p>
          <p>請至瀏覽器設定重新開啟本網站的相機權限後再試一次。</p>
          <button style={styles.startButton} onClick={requestCamera}>
            重新授權
          </button>
        </div>
      )}

      {status === CAMERA_STATUS.UNSUPPORTED && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>此裝置或瀏覽器不支援相機功能</p>
        </div>
      )}

      {status === CAMERA_STATUS.ERROR && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>相機初始化發生未預期錯誤</p>
          <button style={styles.startButton} onClick={requestCamera}>
            重試
          </button>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && (
        <div style={{ ...styles.cameraContainer, aspectRatio }}>
          <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

          {/* 模型載入狀態提示 */}
          {!modelReady && !modelError && (
            <div style={styles.modelStatusBadge}>模型載入中...</div>
          )}
          {modelError && (
            <div style={styles.modelStatusBadge}>模型載入失敗，請確認 public/model 路徑</div>
          )}

          <svg style={styles.guideOverlay} preserveAspectRatio="none">
            {/* 固定目標引導框（白色虛線） */}
            {template && (
              <>
                <rect
                  x={`${template.licensePlate.xMin}%`}
                  y={`${template.licensePlate.yMin}%`}
                  width={`${template.licensePlate.xMax - template.licensePlate.xMin}%`}
                  height={`${template.licensePlate.yMax - template.licensePlate.yMin}%`}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="2"
                  strokeDasharray="6,4"
                  strokeOpacity="0.6"
                />
                <rect
                  x={`${template.wheel.xMin}%`}
                  y={`${template.wheel.yMin}%`}
                  width={`${template.wheel.xMax - template.wheel.xMin}%`}
                  height={`${template.wheel.yMax - template.wheel.yMin}%`}
                  fill="none"
                  stroke="#ffffff"
                  strokeWidth="2"
                  strokeDasharray="6,4"
                  strokeOpacity="0.6"
                />
              </>
            )}

            {/* 即時偵測框：對準時變綠色，未對準時橘色 */}
            {Object.entries(detections).map(([key, det]) => (
              <rect
                key={key}
                x={`${det.xMinPct}%`}
                y={`${det.yMinPct}%`}
                width={`${det.xMaxPct - det.xMinPct}%`}
                height={`${det.yMaxPct - det.yMinPct}%`}
                fill="none"
                stroke={det.aligned ? "#00ff00" : "#ff9900"}
                strokeWidth="3"
              />
            ))}
          </svg>

          {/* 除錯用文字資訊：顯示信心分數與對準狀態 */}
          <div style={styles.debugInfo}>
            {Object.entries(detections).map(([key, det]) => (
              <div key={key}>
                {key}：conf={det.conf.toFixed(3)}，
                {det.aligned ? "✅ 已對準" : "未對準"}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  pageWrapper: {
    width: "100vw",
    height: "100vh",
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
  errorText: {
    color: "#ff4d4f",
    fontWeight: "bold",
    fontSize: "18px",
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
  cameraContainer: {
    position: "relative",
    width: "100%",
    maxHeight: "100vh",
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  guideOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  hiddenCanvas: {
    display: "none",
  },
  modelStatusBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    color: "#fff",
    padding: "4px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    zIndex: 10,
  },
  debugInfo: {
    position: "absolute",
    bottom: 8,
    left: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "13px",
    lineHeight: 1.5,
    zIndex: 10,
  },
};
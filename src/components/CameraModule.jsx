import { useState, useRef, useEffect, useCallback } from "react";
import * as tf from "@tensorflow/tfjs";

// ============================================
// 模型與偵測相關設定
// ============================================
const MODEL_URL = `${import.meta.env.BASE_URL}model/model.json`;
const CLASS_NAMES = ["license_plate", "wheel"];

const CONFIDENCE_THRESHOLD = 0.25; 
const INFERENCE_INTERVAL_MS = 150; 
const POSITION_TOLERANCE_PERCENT = 5; 
const AREA_TOLERANCE_RATIO = 0.1; 

const GUIDE_TEMPLATES = {
  front_left: {
    label: "左前",
    licensePlate: { xMin: 7.4, xMax: 18.7, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 63.3, xMax: 77.9, yMin: 49.6, yMax: 64.4 },
  },
};

const CAMERA_STATUS = {
  IDLE: "idle",
  REQUESTING: "requesting",
  GRANTED: "granted",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
};

function keyToTemplateField(key) {
  return key === "license_plate" ? "licensePlate" : "wheel";
}

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
  const inputCanvasRef = useRef(null); 
  const intervalRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [currentPosition] = useState("front_left");
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [detections, setDetections] = useState({});

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
        height: { ideal: 1920 },
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
    return () => { cancelled = true; };
  }, []);

  const runInference = useCallback(() => {
    const video = videoRef.current;
    const model = modelRef.current;
    const canvas = inputCanvasRef.current;

    if (!video || !model || !canvas || video.readyState < 2) return;

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    if (!rawW || !rawH) return;

    const isLandscapeFeed = rawW > rawH;
    
    const logicalW = isLandscapeFeed ? rawH : rawW;
    const logicalH = isLandscapeFeed ? rawW : rawH;

    const scale = 640 / Math.max(logicalW, logicalH);
    const newW = Math.round(logicalW * scale);
    const newH = Math.round(logicalH * scale);
    const padLeft = Math.floor((640 - newW) / 2);
    const padTop = Math.floor((640 - newH) / 2);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 640, 640);

    ctx.save();
    if (isLandscapeFeed) {
      ctx.translate(320, 320);
      ctx.rotate(Math.PI / 2); 
      ctx.drawImage(video, 0, 0, rawW, rawH, -newH / 2, -newW / 2, newH, newW);
    } else {
      ctx.drawImage(video, 0, 0, rawW, rawH, padLeft, padTop, newW, newH);
    }
    ctx.restore();

    tf.tidy(() => {
      const inputTensor = tf.browser
        .fromPixels(canvas)
        .toFloat()
        .div(255.0)
        .expandDims(0);

      const output = model.execute(inputTensor);
      const parsed = output.squeeze([0]).transpose([1, 0]);
      const data = parsed.arraySync();

      const rawResults = {};

      for (let classId = 0; classId < CLASS_NAMES.length; classId++) {
        let best = null;
        for (let i = 0; i < data.length; i++) {
          const conf = data[i][4 + classId];
          if (conf > CONFIDENCE_THRESHOLD && (!best || conf > best.conf)) {
            best = { conf, cx: data[i][0], cy: data[i][1], w: data[i][2], h: data[i][3] };
          }
        }

        if (best) {
          const x1 = best.cx - best.w / 2;
          const y1 = best.cy - best.h / 2;
          const x2 = best.cx + best.w / 2;
          const y2 = best.cy + best.h / 2;

          const realX1 = (x1 - padLeft) / scale;
          const realY1 = (y1 - padTop) / scale;
          const realX2 = (x2 - padLeft) / scale;
          const realY2 = (y2 - padTop) / scale;

          const cssW = video.clientWidth;
          const cssH = video.clientHeight;

          const scaleCover = Math.max(cssW / logicalW, cssH / logicalH);
          const renderedW = logicalW * scaleCover; 
          const renderedH = logicalH * scaleCover; 

          const offsetX = (renderedW - cssW) / 2;
          const offsetY = (renderedH - cssH) / 2;

          const screenX1 = realX1 * scaleCover - offsetX;
          const screenY1 = realY1 * scaleCover - offsetY;
          const screenX2 = realX2 * scaleCover - offsetX;
          const screenY2 = realY2 * scaleCover - offsetY;

          rawResults[CLASS_NAMES[classId]] = {
            conf: best.conf,
            xMinPct: (screenX1 / cssW) * 100,
            xMaxPct: (screenX2 / cssW) * 100,
            yMinPct: (screenY1 / cssH) * 100,
            yMaxPct: (screenY2 / cssH) * 100,
          };
        }
      }
      setDetections(evaluateAlignment(rawResults, currentPosition));
    });
  }, [currentPosition]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || !modelReady) return;
    intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [status, modelReady, runInference]);

  // ============================================
  // 拍照與存檔功能
  // ============================================
  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    const isLandscapeFeed = rawW > rawH;

    const logicalW = isLandscapeFeed ? rawH : rawW;
    const logicalH = isLandscapeFeed ? rawW : rawH;

    let cropW = logicalW;
    let cropH = logicalH;
    const targetRatio = 9 / 16;
    const currentRatio = logicalW / logicalH;

    if (currentRatio > targetRatio) {
      cropW = logicalH * targetRatio;
    } else {
      cropH = logicalW / targetRatio;
    }

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d");

    ctx.translate(cropW / 2, cropH / 2);

    if (isLandscapeFeed) {
      ctx.rotate(Math.PI / 2);
    }

    ctx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);

    const photoDataUrl = canvas.toDataURL("image/jpeg", 0.9);
    
    // 執行存檔至設備的非同步邏輯
    const savePhotoToDevice = async () => {
      const fileName = `car_detect_${Date.now()}.jpg`;

      // 1. 嘗試使用 Web Share API (手機端最佳體驗)
      if (navigator.share) {
        try {
          const res = await fetch(photoDataUrl);
          const blob = await res.blob();
          const file = new File([blob], fileName, { type: "image/jpeg" });

          if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
              files: [file],
              title: "車況檢測照片"
            });
            console.log("照片儲存/分享成功！");
            return;
          }
        } catch (err) {
          console.log("使用者取消分享或發生錯誤：", err);
          return; 
        }
      }

      // 2. 備案：傳統瀏覽器下載機制 (PC 端或不支援 Share API 時)
      const link = document.createElement("a");
      link.href = photoDataUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    savePhotoToDevice();
  }, []);

  const template = GUIDE_TEMPLATES[currentPosition];

  return (
    <div style={styles.pageWrapper}>
      <canvas ref={inputCanvasRef} width={640} height={640} style={styles.hiddenCanvas} />

      {status === CAMERA_STATUS.IDLE && (
        <div style={styles.centerScreen}>
          <button style={styles.startButton} onClick={requestCamera}>開始檢測</button>
        </div>
      )}

      {status === CAMERA_STATUS.REQUESTING && <div style={styles.centerScreen}><p>正在請求相機權限...</p></div>}
      {status === CAMERA_STATUS.DENIED && <div style={styles.centerScreen}><p style={styles.errorText}>需要相機權限才能進行檢測</p></div>}
      {status === CAMERA_STATUS.UNSUPPORTED && <div style={styles.centerScreen}><p style={styles.errorText}>不支援相機功能</p></div>}
      {status === CAMERA_STATUS.ERROR && <div style={styles.centerScreen}><p style={styles.errorText}>初始化發生錯誤</p></div>}

      {status === CAMERA_STATUS.GRANTED && (
        <div style={styles.cameraContainer}>
          
          {/* 即時相機畫面 */}
          <div style={styles.viewfinder}>
            <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

            {!modelReady && !modelError && <div style={styles.modelStatusBadge}>模型載入中...</div>}
            
            <svg style={styles.guideOverlay} preserveAspectRatio="none">
              {template && (
                <>
                  <rect
                    x={`${template.licensePlate.xMin}%`} y={`${template.licensePlate.yMin}%`}
                    width={`${template.licensePlate.xMax - template.licensePlate.xMin}%`} height={`${template.licensePlate.yMax - template.licensePlate.yMin}%`}
                    fill="none" stroke="#ffffff" strokeWidth="2" strokeDasharray="6,4" strokeOpacity="0.6"
                  />
                  <rect
                    x={`${template.wheel.xMin}%`} y={`${template.wheel.yMin}%`}
                    width={`${template.wheel.xMax - template.wheel.xMin}%`} height={`${template.wheel.yMax - template.wheel.yMin}%`}
                    fill="none" stroke="#ffffff" strokeWidth="2" strokeDasharray="6,4" strokeOpacity="0.6"
                  />
                </>
              )}
              {Object.entries(detections).map(([key, det]) => (
                <rect
                  key={key} x={`${det.xMinPct}%`} y={`${det.yMinPct}%`}
                  width={`${det.xMaxPct - det.xMinPct}%`} height={`${det.yMaxPct - det.yMinPct}%`}
                  fill="none" stroke={det.aligned ? "#00ff00" : "#ff9900"} strokeWidth="3"
                />
              ))}
            </svg>

            {/* 拍照按鈕 */}
            <button style={styles.captureButton} onClick={takePhoto}>
              <div style={styles.captureButtonInner} />
            </button>
          </div>

          <div style={styles.debugInfo}>
            <div>Raw: {videoRef.current?.videoWidth}x{videoRef.current?.videoHeight}</div>
            {Object.entries(detections).map(([key, det]) => (
              <div key={key}>
                {key}：conf={det.conf.toFixed(2)}，{det.aligned ? "✅" : "❌"}
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
    height: "100dvh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    overflow: "hidden",
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
  cameraContainer: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  viewfinder: {
    position: "relative",
    width: "100%",
    maxWidth: "calc(100vh * (9 / 16))",
    aspectRatio: "9 / 16", 
    backgroundColor: "#111",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
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
    position: "absolute",
    bottom: 100,
    right: 8,
    width: 120,
    height: 120,
    border: "2px solid yellow",
    zIndex: 20,
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
    top: 8,
    right: 8,
    backgroundColor: "rgba(0,0,0,0.6)",
    color: "#fff",
    padding: "6px 10px",
    borderRadius: "4px",
    fontSize: "13px",
    lineHeight: 1.5,
    zIndex: 10,
  },
  captureButton: {
    position: "absolute",
    bottom: "32px",
    left: "50%",
    transform: "translateX(-50%)",
    width: "72px",
    height: "72px",
    borderRadius: "50%",
    backgroundColor: "rgba(255, 255, 255, 0.4)",
    border: "4px solid #fff",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
    padding: 0,
    zIndex: 30,
  },
  captureButtonInner: {
    width: "54px",
    height: "54px",
    borderRadius: "50%",
    backgroundColor: "#fff",
  },
};
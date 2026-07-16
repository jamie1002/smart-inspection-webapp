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

// 方向鎖相關設定
const GAMMA_THRESHOLD = 25;
const BETA_MIN = 60;
const BETA_MAX = 95;
const ORIENTATION_THROTTLE_MS = 150;
const ORIENTATION_STABLE_SAMPLES = 1;

// 模組 D：畫質檢驗相關設定（漸進式基準 EMA，避免單一雜訊尖峰讓基準暴衝）
const LIVE_BLUR_CHECK_INTERVAL_MS = 200;
const LIVE_BLUR_SAMPLE_WIDTH = 160;
const LIVE_BLUR_STABLE_SAMPLES = 2;
const BLUR_BASELINE_MIN_SAMPLES = 4;
// ⚠️ 未經實測的猜測起始值，若還是太容易判定模糊，先調小 BLUR_RELATIVE_RATIO，再調小這個
const BLUR_BASELINE_EMA_ALPHA = 0.15;
// ⚠️ 未經實測的猜測起始值：分數低於基準值的這個比例就判定模糊，太容易模糊就調小
const BLUR_RELATIVE_RATIO = 0.5;

// 模組 C：位置/距離提示相關設定
// ⚠️ 方向對應關係尚未實機驗證，若提示方向相反，只需要把下面數值從 1 改成 -1
const HORIZONTAL_HINT_SIGN = 1;
const VERTICAL_HINT_SIGN = 1;

// 存檔輸出設定
const MAX_OUTPUT_LONG_EDGE = 1920; // 只在超過此上限時等比例縮小，不放大

// ============================================
// 模組 E：自動快門與流程控制設定
// ============================================
// 🔧 可自行修改測試：五個對齊條件都通過後，要「連續穩定」多久才自動觸發快門
const CAPTURE_STABLE_DURATION_MS = 1000;

// 拍攝順序：左前 → 左後 → 右後 → 右前
const POSITION_SEQUENCE = ["front_left", "left_rear", "right_rear", "right_front"];

const FLOW_STAGE = {
  SHOOTING: "shooting", // 取景/等待對齊/自動快門
  PREVIEW: "preview",   // 剛拍完，等使用者確認保留或重拍
  COMPLETE: "complete", // 四張都確認保留完成
};

const GUIDE_TEMPLATES = {
  front_left: {
    label: "左前",
    licensePlate: { xMin: 7.4, xMax: 18.7, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 63.3, xMax: 77.9, yMin: 49.6, yMax: 64.4 },
  },
  left_rear: {
    label: "左後",
    licensePlate: { xMin: 77.2, xMax: 88.4, yMin: 50.9, yMax: 56.2 },
    wheel: { xMin: 20.7, xMax: 36.5, yMin: 56.1, yMax: 70.6 },
  },
  right_rear: {
    label: "右後",
    licensePlate: { xMin: 10.7, xMax: 25.8, yMin: 51.0, yMax: 58.1 },
    wheel: { xMin: 70.3, xMax: 84.2, yMin: 57.2, yMax: 72.4 },
  },
  right_front: {
    label: "右前",
    licensePlate: { xMin: 77.9, xMax: 92.1, yMin: 56.4, yMax: 63.5 },
    wheel: { xMin: 19.1, xMax: 31.2, yMin: 51.2, yMax: 66.0 },
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

// 計算位置與距離提示（優先權：距離 > 位置）
function evaluatePositionAndDistance(rawResults, position) {
  const template = GUIDE_TEMPLATES[position];
  if (!template) return { positionHint: null, distanceHint: null };

  const candidates = [];

  for (const key of Object.keys(rawResults)) {
    const det = rawResults[key];
    const target = template[keyToTemplateField(key)];
    if (!target) continue;

    const detCenterX = (det.xMinPct + det.xMaxPct) / 2;
    const detCenterY = (det.yMinPct + det.yMaxPct) / 2;
    const targetCenterX = (target.xMin + target.xMax) / 2;
    const targetCenterY = (target.yMin + target.yMax) / 2;

    const dx = detCenterX - targetCenterX;
    const dy = detCenterY - targetCenterY;
    const positionError = Math.sqrt(dx * dx + dy * dy);
    const positionOk =
      Math.abs(dx) <= POSITION_TOLERANCE_PERCENT && Math.abs(dy) <= POSITION_TOLERANCE_PERCENT;

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;
    const areaError = Math.abs(areaRatio - 1);
    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    candidates.push({ key, dx, dy, positionError, positionOk, areaRatio, areaError, areaOk });
  }

  // 未同時偵測到車牌與輪胎時，視為「尚未偵測到完整物件」，不計算位置/距離提示
  if (candidates.length < CLASS_NAMES.length) {
    return { positionHint: null, distanceHint: null, incomplete: true };
  }

  let distanceHint = null;
  const misalignedByArea = candidates.filter((c) => !c.areaOk);
  if (misalignedByArea.length > 0) {
    const worst = misalignedByArea.reduce((a, b) => (b.areaError > a.areaError ? b : a));
    const tooFar = worst.areaRatio < 1;
    distanceHint = {
      text: tooFar ? "請靠近一點" : "請往後退一點",
      arrow: tooFar ? "near" : "far",
      key: worst.key,
    };
  }

  let positionHint = null;
  if (!distanceHint) {
    const misalignedByPosition = candidates.filter((c) => !c.positionOk);
    if (misalignedByPosition.length > 0) {
      const worst = misalignedByPosition.reduce((a, b) => (b.positionError > a.positionError ? b : a));
      const dxAdj = worst.dx * HORIZONTAL_HINT_SIGN;
      const dyAdj = worst.dy * VERTICAL_HINT_SIGN;

      if (Math.abs(dxAdj) >= Math.abs(dyAdj)) {
        positionHint = {
          text: dxAdj > 0 ? "請往左移動" : "請往右移動",
          arrow: dxAdj > 0 ? "left" : "right",
          key: worst.key,
        };
      } else {
        positionHint = {
          text: dyAdj > 0 ? "請往上移動" : "請往下移動",
          arrow: dyAdj > 0 ? "up" : "down",
          key: worst.key,
        };
      }
    }
  }

  return { positionHint, distanceHint, incomplete: false };
}

// 手刻輕量版 Laplacian 模糊分數計算
function calculateBlurScore(sourceCanvas) {
  const { width, height } = sourceCanvas;
  const ctx = sourceCanvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const laplacian =
        gray[idx - width] + gray[idx + width] + gray[idx - 1] + gray[idx + 1] - 4 * gray[idx];
      sum += laplacian;
      sumSq += laplacian * laplacian;
      count++;
    }
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return variance;
}

// 只在超過上限時等比例縮小，避免放大造成反效果模糊
function downscaleCanvasIfNeeded(sourceCanvas, maxLongEdge) {
  const { width, height } = sourceCanvas;
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return sourceCanvas;

  const scale = maxLongEdge / longEdge;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = Math.round(width * scale);
  outCanvas.height = Math.round(height * scale);
  const ctx = outCanvas.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0, outCanvas.width, outCanvas.height);
  return outCanvas;
}

// 方向箭頭元件
function DirectionArrow({ direction }) {
  if (direction === "near" || direction === "far") {
    const rotation = direction === "near" ? 0 : 180;
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
        <path d="M12 3 L16 9 L12 7 L8 9 Z" fill="#fff" />
        <path d="M12 21 L16 15 L12 17 L8 15 Z" fill="#fff" />
      </svg>
    );
  }
  const rotationMap = { up: 0, right: 90, down: 180, left: 270 };
  const rotation = rotationMap[direction] ?? 0;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" style={{ transform: `rotate(${rotation}deg)` }}>
      <path d="M12 2 L20 18 L12 14 L4 18 Z" fill="#fff" />
    </svg>
  );
}

// 嘗試鎖定對焦（不碰 zoom，避免 iOS 被迫切換到超廣角/微距鏡頭）
async function tryLockFocus(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track || typeof track.getCapabilities !== "function") return;

  let capabilities;
  try {
    capabilities = track.getCapabilities();
  } catch (err) {
    console.warn("無法取得相機能力資訊（可忽略）：", err);
    return;
  }

  const advanced = [];

  if (capabilities.focusMode && capabilities.focusMode.includes("manual")) {
    const settings = track.getSettings();
    advanced.push({
      focusMode: "manual",
      focusDistance: settings.focusDistance ?? capabilities.focusDistance?.min,
    });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch (err) {
      console.warn("鎖定對焦失敗（可能裝置不支援，可忽略）：", err);
    }
  }
}

// ============================================
// 模組 E：上傳 API 通道（先用 mock，之後接後端時只改這個函式內部）
// ============================================
function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadPhoto(sessionId, position, sequenceIndex, photoDataUrl) {
  // 🔧 TODO：串接後端時，把下面這段換成真正的 fetch(...) 上傳邏輯
  // 呼叫方式（confirmPhoto 裡怎麼呼叫這個函式）不需要改動
  console.log(
    `[mock upload] session=${sessionId} position=${position} index=${sequenceIndex} size=${photoDataUrl.length}`
  );
  return Promise.resolve({ ok: true, mock: true });
}

export default function CameraModule() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelRef = useRef(null);
  const inputCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const orientationOkRef = useRef(true);
  const liveBlurOkRef = useRef(true);
  const positionHintRef = useRef(null);
  const needsDetectionRef = useRef(true);
  const distanceHintRef = useRef(null);
  const stageRef = useRef(FLOW_STAGE.SHOOTING);
  const canAutoCaptureRef = useRef(false);

  const lastOrientationCheckRef = useRef(0);
  const consecutiveNormalRef = useRef(0);
  const consecutiveBlurOkRef = useRef(0);
  const blurBaselineRef = useRef(null);
  const blurSampleCountRef = useRef(0);
  const detectionsRef = useRef({});
  const stableSinceRef = useRef(null);
  const sessionIdRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [detections, setDetections] = useState({});
  const [orientationOk, setOrientationOk] = useState(true);
  const [orientationIssues, setOrientationIssues] = useState({ betaBad: false, gammaBad: false });

  const [liveBlurOk, setLiveBlurOk] = useState(true);
  const [positionHint, setPositionHint] = useState(null);
  const [needsDetection, setNeedsDetection] = useState(true);
  const [distanceHint, setDistanceHint] = useState(null);

  // 模組 E：流程狀態
  const [stage, setStage] = useState(FLOW_STAGE.SHOOTING);
  const [positionIndex, setPositionIndex] = useState(0);
  const [capturedPhotos, setCapturedPhotos] = useState([]); // [{position, dataUrl}]
  const [previewPhoto, setPreviewPhoto] = useState(null);   // {position, dataUrl}
  const [lastCaptureSnapshot, setLastCaptureSnapshot] = useState(null); // 拍照當下的框線快照
  const [retakeReference, setRetakeReference] = useState(null); // 重拍時顯示的參考框
  const [stableCountdownActive, setStableCountdownActive] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const currentPosition = POSITION_SEQUENCE[positionIndex];

  useEffect(() => {
    detectionsRef.current = detections;
  }, [detections]);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

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

    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      try {
        const permissionResult = await DeviceOrientationEvent.requestPermission();
        if (permissionResult !== "granted") {
          alert(
            "需要方向感測器權限才能使用檢測功能。\n\n若您先前已拒絕，系統將不會再次跳出授權視窗，請至「設定 > Safari > 動作與方向存取」開啟後，重新整理頁面再試一次。"
          );
          setStatus(CAMERA_STATUS.IDLE);
          return;
        }
      } catch (err) {
        console.error("方向感測器授權請求失敗：", err);
        alert(
          "需要方向感測器權限才能使用檢測功能。\n\n若您先前已拒絕，系統將不會再次跳出授權視窗，請至「設定 > Safari > 動作與方向存取」開啟後，重新整理頁面再試一次。"
        );
        setStatus(CAMERA_STATUS.IDLE);
        return;
      }
    }

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
      await tryLockFocus(stream);
      if (!sessionIdRef.current) {
        sessionIdRef.current = generateSessionId();
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

  // 相機串流附加到 video 元素：stage 切回 SHOOTING 時（例如重拍/下一張/完成後重新檢測）
  // video 元素會重新掛載，需要重新指定 srcObject
  useEffect(() => {
    if (
      status === CAMERA_STATUS.GRANTED &&
      stage === FLOW_STAGE.SHOOTING &&
      videoRef.current &&
      streamRef.current
    ) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status, stage]);

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

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED) return;

    const handleOrientation = (event) => {
      const now = Date.now();
      if (now - lastOrientationCheckRef.current < ORIENTATION_THROTTLE_MS) return;
      lastOrientationCheckRef.current = now;

      const { beta, gamma } = event;
      if (beta === null || gamma === null) return;

      const betaBad = beta < BETA_MIN || beta > BETA_MAX;
      const gammaBad = Math.abs(gamma) > GAMMA_THRESHOLD;
      const isNormal = !betaBad && !gammaBad;

      setOrientationIssues({ betaBad, gammaBad });

      if (isNormal) {
        consecutiveNormalRef.current += 1;
        if (consecutiveNormalRef.current >= ORIENTATION_STABLE_SAMPLES) {
          setOrientationOk(true);
          orientationOkRef.current = true;
        }
      } else {
        consecutiveNormalRef.current = 0;
        setOrientationOk(false);
        orientationOkRef.current = false;
      }
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () => window.removeEventListener("deviceorientation", handleOrientation);
  }, [status]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED) return;
    blurBaselineRef.current = null; // 每次重新開啟相機時重置基準
    blurSampleCountRef.current = 0;

    const checkLiveBlur = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;

      const rawW = video.videoWidth;
      const rawH = video.videoHeight;
      if (!rawW || !rawH) return;

      const sampleW = LIVE_BLUR_SAMPLE_WIDTH;
      const sampleH = Math.round(rawH * (sampleW / rawW));

      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = sampleW;
      sampleCanvas.height = sampleH;
      const ctx = sampleCanvas.getContext("2d");
      ctx.drawImage(video, 0, 0, rawW, rawH, 0, 0, sampleW, sampleH);

      const score = calculateBlurScore(sampleCanvas);
      blurSampleCountRef.current += 1;

      let isFrameSharp;
      if (blurBaselineRef.current === null) {
        blurBaselineRef.current = score;
        isFrameSharp = true;
      } else if (blurSampleCountRef.current < BLUR_BASELINE_MIN_SAMPLES) {
        blurBaselineRef.current =
          blurBaselineRef.current * (1 - BLUR_BASELINE_EMA_ALPHA) + score * BLUR_BASELINE_EMA_ALPHA;
        isFrameSharp = true;
      } else {
        isFrameSharp = score >= blurBaselineRef.current * BLUR_RELATIVE_RATIO;
        if (isFrameSharp) {
          blurBaselineRef.current =
            blurBaselineRef.current * (1 - BLUR_BASELINE_EMA_ALPHA) + score * BLUR_BASELINE_EMA_ALPHA;
        }
      }

      if (isFrameSharp) {
        consecutiveBlurOkRef.current += 1;
        if (consecutiveBlurOkRef.current >= LIVE_BLUR_STABLE_SAMPLES) {
          setLiveBlurOk(true);
          liveBlurOkRef.current = true;
        }
      } else {
        consecutiveBlurOkRef.current = 0;
        setLiveBlurOk(false);
        liveBlurOkRef.current = false;
      }
    };

    const timerId = setInterval(checkLiveBlur, LIVE_BLUR_CHECK_INTERVAL_MS);
    return () => clearInterval(timerId);
  }, [status]);

  const runInference = useCallback(() => {
    if (!orientationOkRef.current || stageRef.current !== FLOW_STAGE.SHOOTING) {
      setDetections({});
      setPositionHint(null);
      positionHintRef.current = null;
      setDistanceHint(null);
      distanceHintRef.current = null;
      setNeedsDetection(true);
      needsDetectionRef.current = true;
      return;
    }

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

      const { positionHint: posHint, distanceHint: distHint, incomplete } =
        evaluatePositionAndDistance(rawResults, currentPosition);
      setPositionHint(posHint);
      positionHintRef.current = posHint;
      setDistanceHint(distHint);
      distanceHintRef.current = distHint;
      setNeedsDetection(incomplete);
      needsDetectionRef.current = incomplete;
    });
  }, [currentPosition]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || !modelReady || stage !== FLOW_STAGE.SHOOTING) return;
    intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [status, modelReady, stage, runInference]);

  const savePhotoToDevice = useCallback(async (photoDataUrl) => {
    const fileName = `car_detect_${Date.now()}.jpg`;

    if (navigator.share) {
      try {
        const res = await fetch(photoDataUrl);
        const blob = await res.blob();
        const file = new File([blob], fileName, { type: "image/jpeg" });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "車況檢測照片",
          });
          console.log("照片儲存/分享成功！");
          return;
        }
      } catch (err) {
        console.log("使用者取消分享或發生錯誤：", err);
        return;
      }
    }

    const link = document.createElement("a");
    link.href = photoDataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, []);

  // 模組 E：只負責拍照存進暫存，進入預覽畫面，不做任何存檔/上傳動作
  const takePhoto = useCallback(() => {
    if (stageRef.current !== FLOW_STAGE.SHOOTING) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    // 🔧 移除方向鎖/模糊/對齊的條件擋：手動快門測試時，不管條件符不符合都能強制拍照
    // 自動快門的把關邏輯在 canAutoCaptureRef，不受這裡影響

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

    const outputCanvas = downscaleCanvasIfNeeded(canvas, MAX_OUTPUT_LONG_EDGE);
    const photoDataUrl = outputCanvas.toDataURL("image/jpeg", 0.9);

    // 快照當下的偵測框與提示文字，供之後選擇「重新拍攝」時顯示參考
    setLastCaptureSnapshot({
      detections: detectionsRef.current,
      hint: positionHintRef.current || distanceHintRef.current,
    });

    setSaveError(null);
    setPreviewPhoto({ position: currentPosition, dataUrl: photoDataUrl });
    setStage(FLOW_STAGE.PREVIEW);
  }, [currentPosition]);

  // 模組 E：使用者按「確認保留」——這是點擊事件，帶有使用者手勢，
  // 可以安全呼叫 navigator.share()（自動倒數/背景計時器內絕對不能呼叫這個）
  const confirmPhoto = useCallback(() => {
    if (!previewPhoto) return;
    const photo = previewPhoto;
    const confirmedIndex = positionIndex;

    setCapturedPhotos((prev) => [...prev, photo]);

    savePhotoToDevice(photo.dataUrl).catch((err) => {
      console.error("儲存照片失敗：", err);
      setSaveError("相簿儲存失敗，請確認裝置分享功能是否正常");
    });

    // 背景上傳，不阻塞流程（目前是 mock，之後接後端一樣這樣呼叫）
    uploadPhoto(sessionIdRef.current, photo.position, confirmedIndex, photo.dataUrl).catch((err) => {
      console.error("上傳失敗（目前為 mock，可忽略）：", err);
    });

    setRetakeReference(null);
    setPreviewPhoto(null);

    if (confirmedIndex >= POSITION_SEQUENCE.length - 1) {
      setStage(FLOW_STAGE.COMPLETE);
    } else {
      setPositionIndex(confirmedIndex + 1);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [previewPhoto, positionIndex, savePhotoToDevice]);

  // 模組 E：使用者按「重新拍攝」——回到同一個方位，並顯示上次拍攝當下的框線當參考
  const retakePhoto = useCallback(() => {
    setRetakeReference(lastCaptureSnapshot);
    setPreviewPhoto(null);
    setStage(FLOW_STAGE.SHOOTING);
  }, [lastCaptureSnapshot]);

  // 模組 E：完成畫面按「重新檢測」——整個流程從頭開始（測試用），相機不需要重新授權
  const resetFlow = useCallback(() => {
    sessionIdRef.current = generateSessionId();
    setPositionIndex(0);
    setCapturedPhotos([]);
    setPreviewPhoto(null);
    setLastCaptureSnapshot(null);
    setRetakeReference(null);
    setSaveError(null);
    stableSinceRef.current = null;
    setStableCountdownActive(false);
    setStage(FLOW_STAGE.SHOOTING);
  }, []);

  // 模組 E：完全回到最初畫面（停止相機串流，需要重新按「開始檢測」授權）
  const backToStart = useCallback(() => {
    stopStream();
    sessionIdRef.current = null;
    setPositionIndex(0);
    setCapturedPhotos([]);
    setPreviewPhoto(null);
    setLastCaptureSnapshot(null);
    setRetakeReference(null);
    setSaveError(null);
    stableSinceRef.current = null;
    setStableCountdownActive(false);
    setStage(FLOW_STAGE.SHOOTING);
    setStatus(CAMERA_STATUS.IDLE);
  }, [stopStream]);

  const canAutoCapture =
    orientationOk &&
    liveBlurOk &&
    !needsDetection &&
    !positionHint &&
    !distanceHint &&
    stage === FLOW_STAGE.SHOOTING;

  useEffect(() => {
    canAutoCaptureRef.current = canAutoCapture;
  }, [canAutoCapture]);

  // 模組 E：自動快門穩定計時——canCapture 持續為 true 達 CAPTURE_STABLE_DURATION_MS 就自動拍照
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
        takePhoto();
      } else {
        setStableCountdownActive(true);
      }
    }, 100);

    return () => clearInterval(timerId);
  }, [status, stage, takePhoto]);

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

      {status === CAMERA_STATUS.DENIED && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>需要相機權限才能進行檢測</p>
          <p style={styles.hintText}>
            若按下重試沒有反應，代表瀏覽器已記住您的拒絕設定，請至瀏覽器的網站設定中允許相機權限後，重新整理頁面。
          </p>
          <button style={styles.retryButton} onClick={requestCamera}>重新嘗試</button>
        </div>
      )}

      {status === CAMERA_STATUS.UNSUPPORTED && <div style={styles.centerScreen}><p style={styles.errorText}>不支援相機功能</p></div>}

      {status === CAMERA_STATUS.ERROR && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>初始化發生錯誤</p>
          <button style={styles.retryButton} onClick={requestCamera}>重新嘗試</button>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.SHOOTING && (
        <div style={styles.cameraContainer}>

          <div style={styles.viewfinder}>
            <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

            {!modelReady && !modelError && <div style={styles.modelStatusBadge}>模型載入中...</div>}

            <div style={styles.positionBadge}>{template?.label}（第 {positionIndex + 1} / {POSITION_SEQUENCE.length} 張）</div>

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
              {/* 重新拍攝參考框：灰色虛線，重現上次拍攝當下的偵測位置 */}
              {retakeReference && Object.entries(retakeReference.detections).map(([key, det]) => (
                <rect
                  key={`ref-${key}`} x={`${det.xMinPct}%`} y={`${det.yMinPct}%`}
                  width={`${det.xMaxPct - det.xMinPct}%`} height={`${det.yMaxPct - det.yMinPct}%`}
                  fill="none" stroke="#aaaaaa" strokeWidth="2" strokeDasharray="3,3" strokeOpacity="0.7"
                />
              ))}
            </svg>

            {!orientationOk && (
              <div style={styles.orientationWarning}>
                {orientationIssues.betaBad && <p>請保持手機水平</p>}
                {orientationIssues.gammaBad && <p>請直立鏡頭</p>}
              </div>
            )}

            {orientationOk && !liveBlurOk && (
              <div style={styles.hintBanner}>
                <span>畫面模糊</span>
              </div>
            )}

            {orientationOk && liveBlurOk && needsDetection && (
              <div style={styles.hintBanner}>
                <span>請將車牌與輪胎都置於畫面內</span>
              </div>
            )}

            {orientationOk && liveBlurOk && !needsDetection && distanceHint && (
              <div style={styles.hintBanner}>
                <DirectionArrow direction={distanceHint.arrow} />
                <span>{distanceHint.text}</span>
              </div>
            )}

            {orientationOk && liveBlurOk && !needsDetection && !distanceHint && positionHint && (
              <div style={styles.hintBanner}>
                <DirectionArrow direction={positionHint.arrow} />
                <span>{positionHint.text}</span>
              </div>
            )}

            {orientationOk && liveBlurOk && !needsDetection && !distanceHint && !positionHint && stableCountdownActive && (
              <div style={styles.hintBanner}>
                <span>請保持不動</span>
              </div>
            )}

            {retakeReference && (
              <div style={styles.retakeReferenceBanner}>
                <span>灰色虛線框為上次拍攝位置參考</span>
              </div>
            )}

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

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.PREVIEW && previewPhoto && (
        <div style={styles.previewContainer}>
          <img src={previewPhoto.dataUrl} alt="拍攝預覽" style={styles.previewImage} />
          <div style={styles.previewLabel}>{GUIDE_TEMPLATES[previewPhoto.position]?.label}</div>
          {saveError && <div style={styles.saveErrorText}>{saveError}</div>}
          <div style={styles.previewButtonRow}>
            <button style={styles.retakeButton} onClick={retakePhoto}>重新拍攝</button>
            <button style={styles.confirmButton} onClick={confirmPhoto}>確認保留</button>
          </div>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.COMPLETE && (
        <div style={styles.completeContainer}>
          <p style={styles.completeTitle}>四個角度拍攝完成</p>
          {/* 🔧 之後接後端時，這裡改成顯示後端標記車損的分析結果圖，目前先用拍攝原圖代替 */}
          <div style={styles.thumbnailGrid}>
            {capturedPhotos.map((p) => (
              <div key={p.position} style={styles.thumbnailItem}>
                <img src={p.dataUrl} alt={p.position} style={styles.thumbnailImage} />
                <span style={styles.thumbnailLabel}>{GUIDE_TEMPLATES[p.position]?.label}</span>
              </div>
            ))}
          </div>
          <div style={styles.previewButtonRow}>
            <button style={styles.retakeButton} onClick={backToStart}>回到最開始</button>
            <button style={styles.retryButton} onClick={resetFlow}>重新檢測</button>
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
  retryButton: {
    marginTop: "16px",
    padding: "12px 28px",
    fontSize: "16px",
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
    marginBottom: "8px",
  },
  hintText: {
    color: "#ccc",
    fontSize: "13px",
    lineHeight: 1.6,
    maxWidth: "320px",
    margin: "0 auto",
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
    touchAction: "none",
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
  positionBadge: {
    position: "absolute",
    top: 8,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(0,0,0,0.6)",
    color: "#fff",
    padding: "4px 12px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "bold",
    zIndex: 10,
    whiteSpace: "nowrap",
  },
  orientationWarning: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    textAlign: "center",
    padding: "24px",
    fontSize: "18px",
    fontWeight: "bold",
    gap: "8px",
    zIndex: 40,
  },
  hintBanner: {
    position: "absolute",
    bottom: "120px",
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    color: "#fff",
    padding: "8px 16px",
    borderRadius: "24px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "15px",
    fontWeight: "bold",
    whiteSpace: "nowrap",
    zIndex: 25,
    pointerEvents: "none",
  },
  retakeReferenceBanner: {
    position: "absolute",
    top: 40,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    color: "#aaaaaa",
    padding: "4px 10px",
    borderRadius: "12px",
    fontSize: "12px",
    whiteSpace: "nowrap",
    zIndex: 20,
    pointerEvents: "none",
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
  previewContainer: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: "16px",
    padding: "24px",
  },
  previewImage: {
    maxWidth: "100%",
    maxHeight: "70vh",
    borderRadius: "8px",
  },
  previewLabel: {
    color: "#fff",
    fontSize: "16px",
    fontWeight: "bold",
  },
  saveErrorText: {
    color: "#ff9900",
    fontSize: "13px",
    textAlign: "center",
    maxWidth: "300px",
  },
  previewButtonRow: {
    display: "flex",
    gap: "16px",
  },
  retakeButton: {
    padding: "14px 28px",
    fontSize: "16px",
    borderRadius: "8px",
    border: "2px solid #fff",
    backgroundColor: "transparent",
    color: "#fff",
    fontWeight: "bold",
    cursor: "pointer",
  },
  confirmButton: {
    padding: "14px 28px",
    fontSize: "16px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "#00ff88",
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
  },
  completeContainer: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    alignItems: "center",
    backgroundColor: "#000",
    gap: "20px",
    padding: "24px",
    overflowY: "auto",
    boxSizing: "border-box",
  },
  completeTitle: {
    color: "#fff",
    fontSize: "18px",
    fontWeight: "bold",
  },
  thumbnailGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    width: "100%",
    maxWidth: "280px",
  },
  thumbnailItem: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
  },
  thumbnailImage: {
    width: "100%",
    borderRadius: "6px",
    aspectRatio: "9 / 16",
    objectFit: "cover",
  },
  thumbnailLabel: {
    color: "#ccc",
    fontSize: "13px",
  },
};
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

// ============================================
// 車牌字元辨識模型設定
// ============================================
const CHAR_MODEL_URL = `${import.meta.env.BASE_URL}model_char/model.json`;
const CHAR_CLASS_NAMES = [
  "0", "1", "2", "3", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L",
  "M", "N", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
];
const CHAR_CONFIDENCE_THRESHOLD = 0.6;
const CHAR_NMS_IOU_THRESHOLD = 0.3;
const CHAR_CROP_PADDING_PERCENT = 10;
const CHAR_INPUT_SIZE = 640;

// 方向鎖相關設定
const GAMMA_THRESHOLD = 25;
const BETA_MIN = 60;
const BETA_MAX = 95;
const ORIENTATION_THROTTLE_MS = 150;
const ORIENTATION_STABLE_SAMPLES = 1;

// 模組 D：畫質檢驗相關設定
const LIVE_BLUR_CHECK_INTERVAL_MS = 200;
const LIVE_BLUR_SAMPLE_WIDTH = 160;
const LIVE_BLUR_STABLE_SAMPLES = 2;
const BLUR_BASELINE_MIN_SAMPLES = 4;
const BLUR_BASELINE_EMA_ALPHA = 0.15;
const BLUR_RELATIVE_RATIO = 0.5;

// 模組 C：位置/距離提示相關設定
const HORIZONTAL_HINT_SIGN = -1;
const VERTICAL_HINT_SIGN = 1;

// 存檔輸出設定
const MAX_OUTPUT_LONG_EDGE = 1920;

const DISPLAY_CROP_RATIO = 9 / 16;

// ============================================
// 模組 E：自動快門與流程控制設定
// ============================================
const CAPTURE_STABLE_DURATION_MS = 1000;
const ANALYZING_DURATION_MS = 2000;

const POSITION_SEQUENCE = ["front_left", "left_rear", "right_rear", "right_front"];

const FLOW_STAGE = {
  SHOOTING: "shooting",
  PREVIEW: "preview",
  ANALYZING: "analyzing",
  REVIEW_INTRO: "review_intro",
  REVIEWING: "reviewing",
  DOWNLOAD_PROMPT: "download_prompt",
  MANUAL_SAVE: "manual_save",
  COMPLETE: "complete",
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
    licensePlate: { xMin: 11.6, xMax: 22.8, yMin: 50.9, yMax: 56.2 },
    wheel: { xMin: 63.5, xMax: 79.3, yMin: 56.1, yMax: 70.6 },
  },
  right_front: {
    label: "右前",
    licensePlate: { xMin: 81.3, xMax: 92.6, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 22.1, xMax: 36.7, yMin: 49.6, yMax: 64.4 },
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

// 優先權：方位反轉 > 距離（前後）+ 左右（中心點優先，其次寬度） > 上下置中
function evaluatePositionAndDistance(rawResults, position) {
  const template = GUIDE_TEMPLATES[position];
  if (!template) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: false, incomplete: false };
  }

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

    const detWidthPct = det.xMaxPct - det.xMinPct;
    const targetWidthPct = target.xMax - target.xMin;
    const widthRatio = targetWidthPct > 0 ? detWidthPct / targetWidthPct : 0;

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;
    const areaError = Math.abs(areaRatio - 1);
    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    candidates.push({ key, dx, dy, centerX: detCenterX, widthRatio, areaRatio, areaError, areaOk });
  }

  if (candidates.length < CLASS_NAMES.length) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: false, incomplete: true };
  }

  // 方位反轉判斷（最高優先權）：比對「模板定義的左右順序」與「實際偵測到的左右順序」
  const plateCandidate = candidates.find((c) => c.key === "license_plate");
  const wheelCandidate = candidates.find((c) => c.key === "wheel");
  const plateTargetCenterX = (template.licensePlate.xMin + template.licensePlate.xMax) / 2;
  const wheelTargetCenterX = (template.wheel.xMin + template.wheel.xMax) / 2;
  const expectedPlateLeftOfWheel = plateTargetCenterX < wheelTargetCenterX;
  const actualPlateLeftOfWheel = plateCandidate.centerX < wheelCandidate.centerX;
  const isFlipped = expectedPlateLeftOfWheel !== actualPlateLeftOfWheel;

  if (isFlipped) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: true, incomplete: false };
  }

  // 距離提示（前後，面積比例）——獨立判斷，可與左右提示同時出現
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

  // 左右提示：第一層先看中心點置中，中心點OK後才看第二層寬度
  let horizontalHint = null;
  const misalignedByCenterX = candidates.filter((c) => Math.abs(c.dx) > POSITION_TOLERANCE_PERCENT);

  if (misalignedByCenterX.length > 0) {
    const worst = misalignedByCenterX.reduce((a, b) =>
      Math.abs(b.dx) > Math.abs(a.dx) ? b : a
    );
    const dxAdj = worst.dx * HORIZONTAL_HINT_SIGN;
    horizontalHint = {
      text: dxAdj > 0 ? "請往左移動" : "請往右移動",
      arrow: dxAdj > 0 ? "left" : "right",
      key: worst.key,
    };
  } else {
    // 中心點已置中，才檢查寬度
    const leftCandidate = expectedPlateLeftOfWheel ? plateCandidate : wheelCandidate;
    const rightCandidate = expectedPlateLeftOfWheel ? wheelCandidate : plateCandidate;
    const leftOverWidth = leftCandidate.widthRatio - (1 + AREA_TOLERANCE_RATIO);
    const rightOverWidth = rightCandidate.widthRatio - (1 + AREA_TOLERANCE_RATIO);

    if (leftOverWidth > 0 || rightOverWidth > 0) {
      horizontalHint =
        leftOverWidth >= rightOverWidth
          ? { text: "請往右移動", arrow: "right", key: leftCandidate.key }
          : { text: "請往左移動", arrow: "left", key: rightCandidate.key };
    }
  }

  // 上下置中：最低優先權，只有左右完全通過（中心點+寬度都OK）才計算
  let verticalHint = null;
  if (!horizontalHint) {
    const misalignedByCenterY = candidates.filter((c) => Math.abs(c.dy) > POSITION_TOLERANCE_PERCENT);
    if (misalignedByCenterY.length > 0) {
      const worst = misalignedByCenterY.reduce((a, b) =>
        Math.abs(b.dy) > Math.abs(a.dy) ? b : a
      );
      const dyAdj = worst.dy * VERTICAL_HINT_SIGN;
      verticalHint = {
        text: dyAdj > 0 ? "請往上移動" : "請往下移動",
        arrow: dyAdj > 0 ? "up" : "down",
        key: worst.key,
      };
    }
  }

  return { distanceHint, horizontalHint, verticalHint, isFlipped: false, incomplete: false };
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

function expandBoxByPercent(xMin, xMax, yMin, yMax, paddingPercent) {
  const w = xMax - xMin;
  const h = yMax - yMin;
  const padX = (w * paddingPercent) / 100;
  const padY = (h * paddingPercent) / 100;
  return {
    xMin: xMin - padX,
    xMax: xMax + padX,
    yMin: yMin - padY,
    yMax: yMax + padY,
  };
}

function cropRegionByPercent(sourceCanvas, xMinPct, xMaxPct, yMinPct, yMaxPct) {
  const { width, height } = sourceCanvas;
  const clamp = (v) => Math.min(100, Math.max(0, v));
  const x = (clamp(xMinPct) / 100) * width;
  const y = (clamp(yMinPct) / 100) * height;
  const w = ((clamp(xMaxPct) - clamp(xMinPct)) / 100) * width;
  const h = ((clamp(yMaxPct) - clamp(yMinPct)) / 100) * height;

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.round(w));
  cropCanvas.height = Math.max(1, Math.round(h));
  const ctx = cropCanvas.getContext("2d");
  ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);
  return cropCanvas;
}

function letterboxToSquare(sourceCanvas, size) {
  const { width, height } = sourceCanvas;
  const scale = size / Math.max(width, height);
  const newW = Math.round(width * scale);
  const newH = Math.round(height * scale);
  const padLeft = Math.floor((size - newW) / 2);
  const padTop = Math.floor((size - newH) / 2);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = size;
  outCanvas.height = size;
  const ctx = outCanvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(sourceCanvas, 0, 0, width, height, padLeft, padTop, newW, newH);

  return { canvas: outCanvas, scale, padLeft, padTop };
}

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

async function tryConfigureCamera(stream) {
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

  if (
    capabilities.zoom &&
    typeof capabilities.zoom.min === "number" &&
    typeof capabilities.zoom.max === "number" &&
    capabilities.zoom.min <= 1 &&
    capabilities.zoom.max >= 1
  ) {
    advanced.push({ zoom: 1 });
  }

  if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch (err) {
      console.warn("相機鏡頭設定失敗（可能裝置不支援，可忽略）：", err);
    }
  }
}

function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadPhoto(sessionId, position, sequenceIndex, photoDataUrl) {
  console.log(
    `[mock upload] session=${sessionId} position=${position} index=${sequenceIndex} size=${photoDataUrl.length}`
  );
  return Promise.resolve({ ok: true, mock: true });
}

async function trySharePhotos(photos) {
  if (!navigator.share) return "unsupported";

  try {
    const timestamp = Date.now();
    const files = await Promise.all(
      photos.map(async (photo, index) => {
        const res = await fetch(photo.dataUrl);
        const blob = await res.blob();
        return new File([blob], `car_detect_${photo.position}_${timestamp}_${index}.jpg`, {
          type: "image/jpeg",
        });
      })
    );

    if (!(navigator.canShare && navigator.canShare({ files }))) {
      return "unsupported";
    }

    await navigator.share({ files, title: "車況檢測照片" });
    return "shared";
  } catch (err) {
    if (err.name === "AbortError") {
      return "cancelled";
    }
    console.warn("分享失敗，改用長按儲存引導：", err);
    return "unsupported";
  }
}

export default function CameraModule() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelRef = useRef(null);
  const charModelRef = useRef(null);
  const inputCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const orientationOkRef = useRef(true);
  const liveBlurOkRef = useRef(true);
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
  const [charModelReady, setCharModelReady] = useState(false);
  const [charModelError, setCharModelError] = useState(false);
  const [detections, setDetections] = useState({});
  const [orientationOk, setOrientationOk] = useState(true);
  const [orientationIssues, setOrientationIssues] = useState({ betaBad: false, gammaBad: false });

  const [liveBlurOk, setLiveBlurOk] = useState(true);
  const [needsDetection, setNeedsDetection] = useState(true);
  const [distanceHint, setDistanceHint] = useState(null);
  const [horizontalHint, setHorizontalHint] = useState(null);
  const [verticalHint, setVerticalHint] = useState(null);
  const [isFlipped, setIsFlipped] = useState(false);

  const [stage, setStage] = useState(FLOW_STAGE.SHOOTING);
  const [positionIndex, setPositionIndex] = useState(0);
  const [capturedPhotos, setCapturedPhotos] = useState([]);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [stableCountdownActive, setStableCountdownActive] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [isSharing, setIsSharing] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);

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
      await tryConfigureCamera(stream);
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
    let cancelled = false;
    (async () => {
      try {
        const charModel = await tf.loadGraphModel(CHAR_MODEL_URL);
        if (!cancelled) {
          charModelRef.current = charModel;
          setCharModelReady(true);
        }
      } catch (err) {
        console.error("字元辨識模型載入失敗：", err);
        if (!cancelled) setCharModelError(true);
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
    blurBaselineRef.current = null;
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
      setDistanceHint(null);
      setHorizontalHint(null);
      setVerticalHint(null);
      setIsFlipped(false);
      setNeedsDetection(true);
      return;
    }

    const video = videoRef.current;
    const model = modelRef.current;
    const canvas = inputCanvasRef.current;

    if (!video || !model || !canvas || video.readyState < 2) return;

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    if (!rawW || !rawH) return;

    const { isLandscapeFeed, cropW, cropH } = computeDisplayCropGeometry(rawW, rawH);

    const scale = 640 / Math.max(cropW, cropH);
    const newW = Math.round(cropW * scale);
    const newH = Math.round(cropH * scale);
    const padLeft = Math.floor((640 - newW) / 2);
    const padTop = Math.floor((640 - newH) / 2);

    const ctx = canvas.getContext("2d");
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

          const cropX1 = (x1 - padLeft) / scale;
          const cropY1 = (y1 - padTop) / scale;
          const cropX2 = (x2 - padLeft) / scale;
          const cropY2 = (y2 - padTop) / scale;

          rawResults[CLASS_NAMES[classId]] = {
            conf: best.conf,
            xMinPct: (cropX1 / cropW) * 100,
            xMaxPct: (cropX2 / cropW) * 100,
            yMinPct: (cropY1 / cropH) * 100,
            yMaxPct: (cropY2 / cropH) * 100,
          };
        }
      }

      setDetections(evaluateAlignment(rawResults, currentPosition));

      const {
        distanceHint: distHint,
        horizontalHint: hHint,
        verticalHint: vHint,
        isFlipped: flipped,
        incomplete,
      } = evaluatePositionAndDistance(rawResults, currentPosition);
      setDistanceHint(distHint);
      setHorizontalHint(hHint);
      setVerticalHint(vHint);
      setIsFlipped(flipped);
      setNeedsDetection(incomplete);
    });
  }, [currentPosition]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || !modelReady || stage !== FLOW_STAGE.SHOOTING) return;
    intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [status, modelReady, stage, runInference]);

  const recognizePlateCharacters = useCallback(async (sourceCanvas, plateDetection) => {
    const charModel = charModelRef.current;
    if (!charModel || !plateDetection) return null;

    const expanded = expandBoxByPercent(
      plateDetection.xMinPct,
      plateDetection.xMaxPct,
      plateDetection.yMinPct,
      plateDetection.yMaxPct,
      CHAR_CROP_PADDING_PERCENT
    );
    const plateCanvas = cropRegionByPercent(
      sourceCanvas,
      expanded.xMin,
      expanded.xMax,
      expanded.yMin,
      expanded.yMax
    );

    const { canvas: inputCanvas, scale, padLeft, padTop } = letterboxToSquare(plateCanvas, CHAR_INPUT_SIZE);

    const rawBoxesData = tf.tidy(() => {
      const inputTensor = tf.browser.fromPixels(inputCanvas).toFloat().div(255.0).expandDims(0);
      const output = charModel.execute(inputTensor);
      const parsed = output.squeeze([0]).transpose([1, 0]);
      return parsed.arraySync();
    });

    const candidates = [];
    for (let i = 0; i < rawBoxesData.length; i++) {
      const row = rawBoxesData[i];
      let bestClassId = -1;
      let bestConf = 0;
      for (let c = 0; c < CHAR_CLASS_NAMES.length; c++) {
        const conf = row[4 + c];
        if (conf > bestConf) {
          bestConf = conf;
          bestClassId = c;
        }
      }
      if (bestConf > CHAR_CONFIDENCE_THRESHOLD) {
        const [cx, cy, w, h] = row;
        const x1 = cx - w / 2;
        const y1 = cy - h / 2;
        const x2 = cx + w / 2;
        const y2 = cy + h / 2;
        candidates.push({ classId: bestClassId, conf: bestConf, x1, y1, x2, y2 });
      }
    }

    if (candidates.length === 0) return null;

    const boxesTensor = tf.tensor2d(candidates.map((c) => [c.y1, c.x1, c.y2, c.x2]));
    const scoresTensor = tf.tensor1d(candidates.map((c) => c.conf));

    const nmsIndices = await tf.image.nonMaxSuppressionAsync(
      boxesTensor,
      scoresTensor,
      50,
      CHAR_NMS_IOU_THRESHOLD,
      CHAR_CONFIDENCE_THRESHOLD
    );
    const keepIndices = await nmsIndices.array();
    boxesTensor.dispose();
    scoresTensor.dispose();
    nmsIndices.dispose();

    const kept = keepIndices.map((idx) => {
      const c = candidates[idx];
      const realX1 = (c.x1 - padLeft) / scale;
      const realX2 = (c.x2 - padLeft) / scale;
      return {
        char: CHAR_CLASS_NAMES[c.classId],
        conf: c.conf,
        xCenter: (realX1 + realX2) / 2,
      };
    });

    kept.sort((a, b) => a.xCenter - b.xCenter);

    const text = kept.map((k) => k.char).join("");
    const avgConf = kept.reduce((sum, k) => sum + k.conf, 0) / kept.length;

    return { text, confidence: avgConf };
  }, []);

  const takePhoto = useCallback(() => {
    if (stageRef.current !== FLOW_STAGE.SHOOTING) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    const { isLandscapeFeed, cropW, cropH } = computeDisplayCropGeometry(rawW, rawH);

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

    setPreviewPhoto({ position: currentPosition, dataUrl: photoDataUrl });
    setStage(FLOW_STAGE.PREVIEW);

    setOcrResult(null);
    if (charModelReady && detectionsRef.current["license_plate"]) {
      recognizePlateCharacters(outputCanvas, detectionsRef.current["license_plate"])
        .then((result) => {
          if (result) setOcrResult(result);
        })
        .catch((err) => console.error("字元辨識發生錯誤：", err));
    }
  }, [currentPosition, charModelReady, recognizePlateCharacters]);

  const confirmPhoto = useCallback(() => {
    if (!previewPhoto) return;
    const photo = previewPhoto;
    const confirmedIndex = positionIndex;

    setCapturedPhotos((prev) => [...prev, photo]);

    uploadPhoto(sessionIdRef.current, photo.position, confirmedIndex, photo.dataUrl).catch((err) => {
      console.error("上傳失敗（目前為 mock，可忽略）：", err);
    });

    setPreviewPhoto(null);

    if (confirmedIndex >= POSITION_SEQUENCE.length - 1) {
      setStage(FLOW_STAGE.ANALYZING);
    } else {
      setPositionIndex(confirmedIndex + 1);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [previewPhoto, positionIndex]);

  const retakePhoto = useCallback(() => {
    setPreviewPhoto(null);
    setStage(FLOW_STAGE.SHOOTING);
  }, []);

  useEffect(() => {
    if (stage !== FLOW_STAGE.ANALYZING) return;
    const timerId = setTimeout(() => {
      setStage(FLOW_STAGE.REVIEW_INTRO);
    }, ANALYZING_DURATION_MS);
    return () => clearTimeout(timerId);
  }, [stage]);

  const startReview = useCallback(() => {
    setReviewIndex(0);
    setStage(FLOW_STAGE.REVIEWING);
  }, []);

  const confirmReviewPhoto = useCallback(() => {
    if (reviewIndex >= capturedPhotos.length - 1) {
      setStage(FLOW_STAGE.DOWNLOAD_PROMPT);
    } else {
      setReviewIndex((prev) => prev + 1);
    }
  }, [reviewIndex, capturedPhotos.length]);

  const handleDownloadConfirm = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    const result = await trySharePhotos(capturedPhotos);
    setIsSharing(false);

    if (result === "shared") {
      setStage(FLOW_STAGE.COMPLETE);
    } else if (result === "cancelled") {
      // 使用者主動取消分享面板，停留在下載詢問畫面，讓使用者可以再按一次
    } else {
      setStage(FLOW_STAGE.MANUAL_SAVE);
    }
  }, [capturedPhotos, isSharing]);

  const handleDownloadSkip = useCallback(() => {
    setStage(FLOW_STAGE.COMPLETE);
  }, []);

  const finishManualSave = useCallback(() => {
    setStage(FLOW_STAGE.COMPLETE);
  }, []);

  const resetFlow = useCallback(() => {
    sessionIdRef.current = generateSessionId();
    setPositionIndex(0);
    setCapturedPhotos([]);
    setPreviewPhoto(null);
    setOcrResult(null);
    setReviewIndex(0);
    setIsSharing(false);
    stableSinceRef.current = null;
    setStableCountdownActive(false);
    setStage(FLOW_STAGE.SHOOTING);
  }, []);

  const backToStart = useCallback(() => {
    stopStream();
    sessionIdRef.current = null;
    setPositionIndex(0);
    setCapturedPhotos([]);
    setPreviewPhoto(null);
    setOcrResult(null);
    setReviewIndex(0);
    setIsSharing(false);
    stableSinceRef.current = null;
    setStableCountdownActive(false);
    setStage(FLOW_STAGE.SHOOTING);
    setStatus(CAMERA_STATUS.IDLE);
  }, [stopStream]);

  const canAutoCapture =
    orientationOk &&
    liveBlurOk &&
    !needsDetection &&
    !isFlipped &&
    !distanceHint &&
    !horizontalHint &&
    !verticalHint &&
    stage === FLOW_STAGE.SHOOTING;

  useEffect(() => {
    canAutoCaptureRef.current = canAutoCapture;
  }, [canAutoCapture]);

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
  const reviewPhoto = capturedPhotos[reviewIndex];

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
            </svg>

            {isFlipped && (
              <div style={styles.orientationWarning}>
                <p>請重新確認方位</p>
              </div>
            )}

            {!isFlipped && !orientationOk && (
              <div style={styles.orientationWarning}>
                {orientationIssues.betaBad && <p>請直立鏡頭</p>}
                {orientationIssues.gammaBad && <p>請保持畫面水平</p>}
              </div>
            )}

            {!isFlipped && orientationOk && !liveBlurOk && (
              <div style={styles.hintBanner}>
                <span>畫面模糊</span>
              </div>
            )}

            {!isFlipped && orientationOk && liveBlurOk && needsDetection && (
              <div style={styles.hintBanner}>
                <span>請將車牌與輪胎都置於畫面內</span>
              </div>
            )}

            {!isFlipped && orientationOk && liveBlurOk && !needsDetection && (distanceHint || horizontalHint) && (
              <div style={styles.hintBannerStack}>
                {distanceHint && (
                  <div style={styles.hintPill}>
                    <DirectionArrow direction={distanceHint.arrow} />
                    <span>{distanceHint.text}</span>
                  </div>
                )}
                {horizontalHint && (
                  <div style={styles.hintPill}>
                    <DirectionArrow direction={horizontalHint.arrow} />
                    <span>{horizontalHint.text}</span>
                  </div>
                )}
              </div>
            )}

            {!isFlipped && orientationOk && liveBlurOk && !needsDetection && !distanceHint && !horizontalHint && verticalHint && (
              <div style={styles.hintBanner}>
                <DirectionArrow direction={verticalHint.arrow} />
                <span>{verticalHint.text}</span>
              </div>
            )}

            {!isFlipped && orientationOk && liveBlurOk && !needsDetection && !distanceHint && !horizontalHint && !verticalHint && stableCountdownActive && (
              <div style={styles.hintBanner}>
                <span>請保持不動</span>
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
          {ocrResult && (
            <div style={styles.previewLabel}>
              車牌辨識：{ocrResult.text}（信心 {ocrResult.confidence.toFixed(2)}）
            </div>
          )}
          <div style={styles.previewButtonRow}>
            <button style={styles.retakeButton} onClick={retakePhoto}>重新拍攝</button>
            <button style={styles.confirmButton} onClick={confirmPhoto}>確認保留</button>
          </div>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.ANALYZING && (
        <div style={styles.centerScreen}>
          <p style={styles.analyzingText}>請稍等，AI 辨識目前車況中...</p>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.REVIEW_INTRO && (
        <div style={styles.centerScreen}>
          <p style={styles.analyzingText}>請比對標記的車損是否與現場相符</p>
          <button style={styles.startButton} onClick={startReview}>開始確認</button>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.REVIEWING && reviewPhoto && (
        <div style={styles.reviewPhotoContainer}>
          <img src={reviewPhoto.dataUrl} alt="車損標記比對" style={styles.reviewPhotoImage} />
          <div style={styles.reviewProgressBadge}>
            {GUIDE_TEMPLATES[reviewPhoto.position]?.label}（第 {reviewIndex + 1} / {capturedPhotos.length} 張）
          </div>
          <button style={styles.reviewConfirmButton} onClick={confirmReviewPhoto}>確認無誤</button>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.DOWNLOAD_PROMPT && (
        <div style={styles.centerScreen}>
          <p style={styles.analyzingText}>是否要將照片儲存到手機相簿？</p>
          <div style={styles.previewButtonRow}>
            <button style={styles.retakeButton} onClick={handleDownloadSkip} disabled={isSharing}>否</button>
            <button style={styles.confirmButton} onClick={handleDownloadConfirm} disabled={isSharing}>
              {isSharing ? "處理中..." : "是"}
            </button>
          </div>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.MANUAL_SAVE && (
        <div style={styles.completeContainer}>
          <p style={styles.completeTitle}>此裝置無法自動跳出儲存選單</p>
          <p style={styles.manualSaveHint}>請依序長按下方每張照片，選擇「儲存影像」或「加入照片」，即可存進手機相簿</p>
          <div style={styles.thumbnailGrid}>
            {capturedPhotos.map((p) => (
              <div key={p.position} style={styles.thumbnailItem}>
                <img src={p.dataUrl} alt={p.position} style={styles.thumbnailImage} />
                <span style={styles.thumbnailLabel}>{GUIDE_TEMPLATES[p.position]?.label}</span>
              </div>
            ))}
          </div>
          <button style={styles.startButton} onClick={finishManualSave}>已完成儲存</button>
        </div>
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.COMPLETE && (
        <div style={styles.completeContainer}>
          <p style={styles.completeTitle}>四個角度拍攝完成</p>
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
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "16px",
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
  analyzingText: {
    color: "#fff",
    fontSize: "17px",
    fontWeight: "bold",
    maxWidth: "300px",
    lineHeight: 1.6,
  },
  manualSaveHint: {
    color: "#ccc",
    fontSize: "14px",
    lineHeight: 1.6,
    maxWidth: "300px",
    textAlign: "center",
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
  hintBannerStack: {
    position: "absolute",
    bottom: "120px",
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "8px",
    zIndex: 25,
    pointerEvents: "none",
  },
  hintPill: {
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
  reviewPhotoContainer: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  reviewPhotoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  reviewProgressBadge: {
    position: "absolute",
    top: 16,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(0,0,0,0.6)",
    color: "#fff",
    padding: "4px 12px",
    borderRadius: "4px",
    fontSize: "13px",
    fontWeight: "bold",
    whiteSpace: "nowrap",
    zIndex: 10,
  },
  reviewConfirmButton: {
    position: "absolute",
    bottom: "36px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "14px 40px",
    fontSize: "16px",
    borderRadius: "24px",
    border: "none",
    backgroundColor: "#00ff88",
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
    zIndex: 10,
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
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
// 🔧 從 500 縮短到 200，讓「連續 2 次清晰」的判定週期從最壞 ~1.5~2 秒縮短到最壞 ~600ms，未經實機測試
const LIVE_BLUR_CHECK_INTERVAL_MS = 300;
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

const CAPTURE_STATUS = {
  IDLE: "idle",
  CHECKING: "checking",
  BLOCKED: "blocked",
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

  if (candidates.length === 0) return { positionHint: null, distanceHint: null };

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

  return { positionHint, distanceHint };
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
// ⚠️ 目前維持鎖定，之後若發現搭配距離提示移動時容易因真的失焦而卡住快門，考慮拿掉或改成快門瞬間才鎖定
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

export default function CameraModule() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const modelRef = useRef(null);
  const inputCanvasRef = useRef(null);
  const intervalRef = useRef(null);

  const orientationOkRef = useRef(true);
  const liveBlurOkRef = useRef(true);
  const captureStatusRef = useRef(CAPTURE_STATUS.IDLE);
  const positionHintRef = useRef(null);
  const distanceHintRef = useRef(null);

  const lastOrientationCheckRef = useRef(0);
  const consecutiveNormalRef = useRef(0);
  const consecutiveBlurOkRef = useRef(0);
  const blurBaselineRef = useRef(null);
  const blurSampleCountRef = useRef(0);
  const detectionsRef = useRef({});

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [currentPosition] = useState("front_left");
  const [modelReady, setModelReady] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [detections, setDetections] = useState({});
  const [orientationOk, setOrientationOk] = useState(true);
  const [orientationIssues, setOrientationIssues] = useState({ betaBad: false, gammaBad: false });

  const [captureStatus, setCaptureStatus] = useState(CAPTURE_STATUS.IDLE);
  const [captureError, setCaptureError] = useState(null);
  const [liveBlurOk, setLiveBlurOk] = useState(true);
  const [positionHint, setPositionHint] = useState(null);
  const [distanceHint, setDistanceHint] = useState(null);

  useEffect(() => {
    detectionsRef.current = detections;
  }, [detections]);

  const updateCaptureStatus = useCallback((newStatus) => {
    setCaptureStatus(newStatus);
    captureStatusRef.current = newStatus;
  }, []);

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

    // 統一向所有裝置索求極高的理想值，逼出裝置原生最大無裁切畫質，不寫死特定數字
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
    // 🔧 拿掉 !liveBlurOkRef.current 條件：模糊時只擋快門，偵測框跟位置/距離提示仍持續運作，
    // 讓使用者可以在等待畫面變清晰的同時先把位置對好，不會卡住整個對位流程
    if (
      !orientationOkRef.current ||
      captureStatusRef.current !== CAPTURE_STATUS.IDLE
    ) {
      setDetections({});
      setPositionHint(null);
      positionHintRef.current = null;
      setDistanceHint(null);
      distanceHintRef.current = null;
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

      const { positionHint: posHint, distanceHint: distHint } =
        evaluatePositionAndDistance(rawResults, currentPosition);
      setPositionHint(posHint);
      positionHintRef.current = posHint;
      setDistanceHint(distHint);
      distanceHintRef.current = distHint;
    });
  }, [currentPosition]);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || !modelReady) return;
    intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
    return () => clearInterval(intervalRef.current);
  }, [status, modelReady, runInference]);

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

  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    if (captureStatusRef.current === CAPTURE_STATUS.CHECKING) return;
    if (
      !orientationOkRef.current ||
      !liveBlurOkRef.current ||
      positionHintRef.current ||
      distanceHintRef.current
    ) return;

    updateCaptureStatus(CAPTURE_STATUS.CHECKING);
    setCaptureError(null);

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

    try {
      await savePhotoToDevice(photoDataUrl);
    } catch (err) {
      console.error("儲存照片失敗：", err);
      setCaptureError("儲存照片失敗，請重新嘗試");
      updateCaptureStatus(CAPTURE_STATUS.BLOCKED);
      return;
    }

    updateCaptureStatus(CAPTURE_STATUS.IDLE);
  }, [savePhotoToDevice, updateCaptureStatus]);

  const dismissCaptureError = useCallback(() => {
    setCaptureError(null);
    updateCaptureStatus(CAPTURE_STATUS.IDLE);
  }, [updateCaptureStatus]);

  const template = GUIDE_TEMPLATES[currentPosition];

  const canCapture =
    orientationOk &&
    liveBlurOk &&
    !positionHint &&
    !distanceHint &&
    captureStatus === CAPTURE_STATUS.IDLE;

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

      {status === CAMERA_STATUS.GRANTED && (
        <div style={styles.cameraContainer}>

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

            {!orientationOk && (
              <div style={styles.orientationWarning}>
                {orientationIssues.betaBad && <p>請保持手機水平</p>}
                {orientationIssues.gammaBad && <p>請直立鏡頭</p>}
              </div>
            )}

            {/* 🔧 模糊警告改成跟位置/距離提示同一套小提示條，不再蓋滿整個畫面 */}
            {orientationOk && !liveBlurOk && (
              <div style={styles.hintBanner}>
                <span>畫面模糊</span>
              </div>
            )}

            {orientationOk && liveBlurOk && distanceHint && (
              <div style={styles.hintBanner}>
                <DirectionArrow direction={distanceHint.arrow} />
                <span>{distanceHint.text}</span>
              </div>
            )}

            {orientationOk && liveBlurOk && !distanceHint && positionHint && (
              <div style={styles.hintBanner}>
                <DirectionArrow direction={positionHint.arrow} />
                <span>{positionHint.text}</span>
              </div>
            )}

            {captureStatus === CAPTURE_STATUS.CHECKING && (
              <div style={styles.checkingOverlay}>
                <p>儲存中...</p>
              </div>
            )}

            {captureStatus === CAPTURE_STATUS.BLOCKED && captureError && (
              <div style={styles.blockedOverlay}>
                <p style={styles.blockedText}>{captureError}</p>
                <button style={styles.retryButton} onClick={dismissCaptureError}>重新拍攝</button>
              </div>
            )}

            {canCapture && (
              <button style={styles.captureButton} onClick={takePhoto}>
                <div style={styles.captureButtonInner} />
              </button>
            )}
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
  checkingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    color: "#fff",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontSize: "18px",
    fontWeight: "bold",
    zIndex: 50,
  },
  blockedOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.9)",
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    textAlign: "center",
    padding: "24px",
    gap: "16px",
    zIndex: 50,
  },
  blockedText: {
    fontSize: "16px",
    fontWeight: "bold",
    color: "#ff9900",
    maxWidth: "300px",
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
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

// 🔧 模型輸入與拍照存檔共用的裁切比例（= APP 顯示畫面的比例）
const DISPLAY_CROP_RATIO = 9 / 16;

// ============================================
// 模組 E：自動快門與流程控制設定
// ============================================
// 🔧 可自行修改測試：五個對齊條件都通過後，要「連續穩定」多久才自動觸發快門
const CAPTURE_STABLE_DURATION_MS = 1000;

// 🔧 模擬等待後端 AI 辨識車損的時間，之後接後端時改成實際等待 API 回應，這個常數可移除
const ANALYZING_DURATION_MS = 2000;

// 拍攝順序：左前 → 左後 → 右後 → 右前
const POSITION_SEQUENCE = ["front_left", "left_rear", "right_rear", "right_front"];

const FLOW_STAGE = {
  SHOOTING: "shooting",             // 取景/等待對齊/自動快門
  PREVIEW: "preview",               // 剛拍完，等使用者確認保留或重拍
  ANALYZING: "analyzing",           // 模擬等待後端 AI 辨識車況
  REVIEW_INTRO: "review_intro",     // 提示使用者即將比對車損標記
  REVIEWING: "reviewing",           // 逐張比對確認車損標記
  DOWNLOAD_PROMPT: "download_prompt", // 詢問是否下載照片到相簿
  MANUAL_SAVE: "manual_save",       // 裝置不支援分享 API 時，引導使用者長按儲存
  COMPLETE: "complete",             // 全部完成
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

// 🔧 模組 E 簡化：計算「APP 顯示畫面」(9:16 裁切) 的裁切尺寸與是否為橫向 feed
// takePhoto() 跟 runInference() 都呼叫這支，確保拍照存檔跟模型輸入用同一套裁切邏輯
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

// 設定相機鏡頭：明確鎖定 1x 主鏡頭（避免部分 Android 裝置變焦到極端值時切換到超廣角/微距鏡頭），
// 對焦改用連續自動對焦（不再鎖定對焦距離）。
// 注意：getCapabilities() 在 iOS Safari 上不存在，這整段對 iOS 完全不生效（安全，因為 iOS 本來就預設主鏡頭）
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

  // 明確鎖定變焦在 1x（不是 zoom.min，避免部分機型的 min 值對應到超廣角鏡頭）
  if (
    capabilities.zoom &&
    typeof capabilities.zoom.min === "number" &&
    typeof capabilities.zoom.max === "number" &&
    capabilities.zoom.min <= 1 &&
    capabilities.zoom.max >= 1
  ) {
    advanced.push({ zoom: 1 });
  }

  // 明確指定連續自動對焦（多數裝置預設本來就是這個，這裡明確指定較保險）
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

// 🔧 唯一能保證存進系統相簿的方式：navigator.share() 讓使用者在系統面板點「儲存到照片」。
// 回傳三種結果：
//   "shared"      分享成功（使用者已選擇儲存或其他分享目標）
//   "cancelled"   使用者主動取消分享面板，不當作錯誤，停留原畫面即可
//   "unsupported" 裝置不支援 / 呼叫失敗，需要改用「引導長按儲存」畫面
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
  const [reviewIndex, setReviewIndex] = useState(0); // 逐張比對車損標記時，目前顯示第幾張
  const [isSharing, setIsSharing] = useState(false); // 分享處理中，避免重複點擊

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

  // 相機串流附加到 video 元素：stage 切回 SHOOTING 時（例如重拍/下一張/重新檢測）
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

    // 模型輸入畫面採用「APP 顯示畫面」(9:16 裁切)，跟 takePhoto() 用同一套裁切幾何
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

  // 模組 E：只負責拍照存進暫存，進入預覽畫面，不做任何存檔/上傳動作
  const takePhoto = useCallback(() => {
    if (stageRef.current !== FLOW_STAGE.SHOOTING) return;

    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    // 🔧 移除方向鎖/模糊/對齊的條件擋：手動快門測試時，不管條件符不符合都能強制拍照
    // 自動快門的把關邏輯在 canAutoCaptureRef，不受這裡影響

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

    // 快照當下的偵測框與提示文字，供之後選擇「重新拍攝」時顯示參考
    setLastCaptureSnapshot({
      detections: detectionsRef.current,
      hint: positionHintRef.current || distanceHintRef.current,
    });

    setPreviewPhoto({ position: currentPosition, dataUrl: photoDataUrl });
    setStage(FLOW_STAGE.PREVIEW);
  }, [currentPosition]);

  // 模組 E：使用者按「確認保留」——只把照片存進暫存陣列並前進，
  // 不在這裡存相簿（相簿存檔集中在四張都比對完之後，DOWNLOAD_PROMPT 那一步）
  const confirmPhoto = useCallback(() => {
    if (!previewPhoto) return;
    const photo = previewPhoto;
    const confirmedIndex = positionIndex;

    setCapturedPhotos((prev) => [...prev, photo]);

    // 背景上傳，不阻塞流程（目前是 mock，之後接後端一樣這樣呼叫）
    uploadPhoto(sessionIdRef.current, photo.position, confirmedIndex, photo.dataUrl).catch((err) => {
      console.error("上傳失敗（目前為 mock，可忽略）：", err);
    });

    setRetakeReference(null);
    setPreviewPhoto(null);

    if (confirmedIndex >= POSITION_SEQUENCE.length - 1) {
      setStage(FLOW_STAGE.ANALYZING);
    } else {
      setPositionIndex(confirmedIndex + 1);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [previewPhoto, positionIndex]);

  // 模組 E：使用者按「重新拍攝」——回到同一個方位重新取景
  const retakePhoto = useCallback(() => {
    setPreviewPhoto(null);
    setStage(FLOW_STAGE.SHOOTING);
  }, []);

  // 模組 E：模擬等待後端 AI 辨識，時間到自動進入「請比對車損標記」畫面
  useEffect(() => {
    if (stage !== FLOW_STAGE.ANALYZING) return;
    const timerId = setTimeout(() => {
      setStage(FLOW_STAGE.REVIEW_INTRO);
    }, ANALYZING_DURATION_MS);
    return () => clearTimeout(timerId);
  }, [stage]);

  // 使用者按「開始確認」，從第一張開始逐張比對
  const startReview = useCallback(() => {
    setReviewIndex(0);
    setStage(FLOW_STAGE.REVIEWING);
  }, []);

  // 使用者對目前這張按「確認無誤」，前進下一張，最後一張確認完進入下載詢問
  const confirmReviewPhoto = useCallback(() => {
    if (reviewIndex >= capturedPhotos.length - 1) {
      setStage(FLOW_STAGE.DOWNLOAD_PROMPT);
    } else {
      setReviewIndex((prev) => prev + 1);
    }
  }, [reviewIndex, capturedPhotos.length]);

  // 使用者選擇「是」要下載照片：這是點擊事件，帶有使用者手勢，可以安全呼叫 navigator.share()
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

  // 使用者選擇「否」，跳過儲存直接完成
  const handleDownloadSkip = useCallback(() => {
    setStage(FLOW_STAGE.COMPLETE);
  }, []);

  // 手動儲存引導畫面按「完成」，代表使用者已自行長按儲存
  const finishManualSave = useCallback(() => {
    setStage(FLOW_STAGE.COMPLETE);
  }, []);

  // 模組 E：完成畫面按「重新檢測」——整個流程從頭開始（測試用），相機不需要重新授權
  const resetFlow = useCallback(() => {
    sessionIdRef.current = generateSessionId();
    setPositionIndex(0);
    setCapturedPhotos([]);
    setPreviewPhoto(null);
    setLastCaptureSnapshot(null);
    setRetakeReference(null);
    setReviewIndex(0);
    setIsSharing(false);
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
    !positionHint &&
    !distanceHint &&
    stage === FLOW_STAGE.SHOOTING;

  useEffect(() => {
    canAutoCaptureRef.current = canAutoCapture;
  }, [canAutoCapture]);

  // 模組 E：自動快門穩定計時——canAutoCapture 持續為 true 達 CAPTURE_STABLE_DURATION_MS 就自動拍照
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
                {orientationIssues.betaBad && <p>請直立鏡頭</p>}
                {orientationIssues.gammaBad && <p>請保持畫面水平</p>}
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
          {/* 🔧 之後接後端時，這裡的 dataUrl 改成後端回傳的「車損標記後」照片，目前先用拍攝原圖代替 */}
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
  // 模組 E：逐張比對車損標記畫面——照片鋪滿，按鈕疊在下方（拍攝時已把主物件置中，下方位置不影響判讀）
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
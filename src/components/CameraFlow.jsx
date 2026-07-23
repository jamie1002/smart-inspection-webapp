// 流程狀態機協調器（取代舊 CameraModule）
// 只組合 hooks、持有 stage、決定渲染哪支畫面元件；不含演算法。
import { useState, useRef, useEffect, useCallback, useMemo } from "react";

import { IS_TEST_MODE } from "../config/appConfig";
import { CAMERA_STATUS, FLOW_STAGE } from "../constants/flow";
import {
  POSITION_SEQUENCE,
  POSITION_INDEX,
  GUIDE_TEMPLATES,
  PHOTO_TYPE_TO_POSITION,
} from "../constants/guideTemplates";
import { CAR_MODELS, DEFAULT_CAR_MODEL } from "../constants/carModels";
import { ASPECT_RATIOS, DEFAULT_ASPECT_RATIO } from "../constants/aspectRatios";
import {
  MAX_OUTPUT_LONG_EDGE,
  ANALYZING_DURATION_MS,
  BLUR_RELATIVE_RATIO,
} from "../constants/detection";
import { computeDisplayCropGeometry, downscaleCanvasIfNeeded } from "../utils/geometry";
import { generateSessionId } from "../utils/session";
import { trySharePhotos } from "../utils/share";
import { getCurrentPositionSafe } from "../utils/geolocation";
import { recognizePlateCharacters } from "../services/models";
import { createRental, uploadBatchPhotosRecords, subscribeToRentalAnalysis } from "../services/upload";

import { useCamera } from "../hooks/useCamera";
import { useModels } from "../hooks/useModels";
import { useOrientation } from "../hooks/useOrientation";
import { useLiveBlur } from "../hooks/useLiveBlur";
import { useInference } from "../hooks/useInference";
import { useAutoCapture } from "../hooks/useAutoCapture";

import StartScreen from "./camera/StartScreen";
import Viewfinder from "./camera/Viewfinder";
import PreviewScreen from "./camera/PreviewScreen";
import AnalyzingScreen from "./camera/AnalyzingScreen";
import AnalysisDebugScreen from "./camera/AnalysisDebugScreen";
import ReviewIntroScreen from "./camera/ReviewIntroScreen";
import ReviewScreen from "./camera/ReviewScreen";
import DownloadPromptScreen from "./camera/DownloadPromptScreen";
import ManualSaveScreen from "./camera/ManualSaveScreen";
import CompleteScreen from "./camera/CompleteScreen";
import { colors } from "../styles/theme";

function isPhotoReceived(photoData) {
  if (!photoData) return false;
  // 1. 若 damages 陣列有內容 (長度 > 0，即有車損座標資訊)
  if (Array.isArray(photoData.damages) && photoData.damages.length > 0) {
    return true;
  }
  // 2. 若 damages 為空陣列或 null，需確認狀態已明確標記為完成 (非 pending)
  const statusStr = String(
    photoData.status || photoData.qc_status || photoData.analysis_result || ""
  ).toLowerCase();
  return (
    statusStr === "none" ||
    statusStr === "completed" ||
    statusStr === "analyzed" ||
    statusStr === "ai_completed"
  );
}

export default function CameraFlow() {
  const inputCanvasRef = useRef(null);
  const rentalIdRef = useRef(null);
  const retakeCountRef = useRef({});
  const pendingMetaRef = useRef(null);
  const stageRef = useRef(FLOW_STAGE.SHOOTING);

  const { status, setStatus, videoRef, streamRef, sessionIdRef, gpsRef, requestCamera, stopStream } = useCamera();
  const { carModelRef, charModelRef, modelReady, modelError, charModelReady } = useModels();
  const { orientationOk, orientationIssues, orientationOkRef, latestOrientationRef } = useOrientation(status);
  const { liveBlurOk, blurBaselineRef, lastBlurScoreRef } = useLiveBlur(status, videoRef);

  const [stage, setStage] = useState(FLOW_STAGE.SHOOTING);
  const [currentPosition, setCurrentPosition] = useState(POSITION_SEQUENCE[0]);
  const [capturedByPosition, setCapturedByPosition] = useState({});
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [ocrResult, setOcrResult] = useState(null);
  const [ocrChecking, setOcrChecking] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [isSharing, setIsSharing] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(40);

  const receivedCount = useMemo(
    () => POSITION_SEQUENCE.filter((p) => isPhotoReceived(capturedByPosition[p])).length,
    [capturedByPosition]
  );

  const [personnelName, setPersonnelName] = useState("");
  const [plateNumberInput, setPlateNumberInput] = useState("");
  const [carModel, setCarModel] = useState(DEFAULT_CAR_MODEL);
  const [cropRatio, setCropRatio] = useState(DEFAULT_ASPECT_RATIO);

  const activeModel = CAR_MODELS[carModel];
  const template = activeModel?.variants?.[cropRatio]?.templates?.[currentPosition] || GUIDE_TEMPLATES[currentPosition];
  // 需要陣列的地方（Review/Complete/分享）依 POSITION_SEQUENCE 順序自 map 取出，確保順序穩定
  const capturedPhotos = useMemo(
    () => POSITION_SEQUENCE.map((p) => capturedByPosition[p]).filter(Boolean),
    [capturedByPosition]
  );

  useEffect(() => { stageRef.current = stage; }, [stage]);

  const {
    detections,
    detectionsRef,
    needsDetection,
    distanceHint,
    horizontalHint,
    verticalHint,
    isFlipped,
  } = useInference({
    status,
    modelReady,
    stage,
    currentPosition,
    templates: activeModel?.variants?.[cropRatio]?.templates || GUIDE_TEMPLATES,
    cropRatio: ASPECT_RATIOS[cropRatio]?.ratio || (9 / 16),
    videoRef,
    carModelRef,
    inputCanvasRef,
    orientationOkRef,
  });

  // 綁定串流到 video
  useEffect(() => {
    if (
      status === CAMERA_STATUS.GRANTED &&
      stage === FLOW_STAGE.SHOOTING &&
      videoRef.current &&
      streamRef.current
    ) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status, stage, videoRef, streamRef]);

  // 進入 GRANTED 時建立訂單（僅一次）
  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED || rentalIdRef.current) return;
    const vehicleId = plateNumberInput.replace(/[^A-Z0-9]/g, "");
    createRental({
      sessionId: sessionIdRef.current,
      vehicleId,
      carModel,
      personnelName,
      plateInput: plateNumberInput,
      plateInputNormalized: vehicleId,
    })
      .then((id) => { rentalIdRef.current = id; })
      .catch((err) => console.error("建立訂單失敗（可忽略，不擋流程）：", err));
  }, [status, plateNumberInput, personnelName, carModel, sessionIdRef]);

  // ----- 輸入欄位 -----
  const handlePersonnelChange = useCallback((e) => {
    setPersonnelName(e.target.value.replace(/[^\p{L}\p{N}\s]/gu, ""));
  }, []);
  const handlePlateChange = useCallback((e) => {
    setPlateNumberInput(e.target.value.toUpperCase());
  }, []);
  const canStart = personnelName.trim().length > 0 && plateNumberInput.length > 0;

  const handleStart = useCallback(() => {
    if (status === CAMERA_STATUS.IDLE && !canStart) return;
    requestCamera();
  }, [status, canStart, requestCamera]);

  // ----- 拍照 -----
  const normalizedPlateNumber = plateNumberInput.replace(/[^A-Z0-9]/g, "");
  const plateMismatch = !ocrChecking && ocrResult && ocrResult.text !== normalizedPlateNumber;

  const takePhoto = useCallback((captureMode) => {
    if (stageRef.current !== FLOW_STAGE.SHOOTING) return;
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    const { cropW, cropH } = computeDisplayCropGeometry(rawW, rawH, ASPECT_RATIOS[cropRatio]?.ratio || (9 / 16));

    const canvas = document.createElement("canvas");
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d");
    ctx.translate(cropW / 2, cropH / 2);
    ctx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);

    const outputCanvas = downscaleCanvasIfNeeded(canvas, MAX_OUTPUT_LONG_EDGE);
    const photoDataUrl = outputCanvas.toDataURL("image/jpeg", 0.9);

    // 快照拍照當下 metadata
    const detSnapshot = detectionsRef.current;
    pendingMetaRef.current = {
      position: currentPosition,
      capturedAt: Date.now(),
      gps: gpsRef.current,
      detections: detSnapshot,
      orientation: { ...latestOrientationRef.current },
      blur: {
        score: lastBlurScoreRef.current,
        baseline: blurBaselineRef.current,
        relativeRatio: BLUR_RELATIVE_RATIO,
      },
      captureMode,
      retakeCount: retakeCountRef.current[currentPosition] || 0,
      imageWidth: outputCanvas.width,
      imageHeight: outputCanvas.height,
    };

    // 背景刷新 GPS 供下一張使用
    getCurrentPositionSafe().then((pos) => { if (pos.source !== "none") gpsRef.current = pos; }).catch(() => {});

    setPreviewPhoto({ position: currentPosition, dataUrl: photoDataUrl });
    setStage(FLOW_STAGE.PREVIEW);

    // 車牌辨識（非同步，不阻塞預覽）
    setOcrResult(null);
    setOcrChecking(false);
    if (charModelReady && detSnapshot["license_plate"]) {
      setOcrChecking(true);
      recognizePlateCharacters(charModelRef.current, outputCanvas, detSnapshot["license_plate"], template?.licensePlate)
        .then((result) => { if (result) setOcrResult(result); })
        .catch((err) => console.error("字元辨識發生錯誤：", err))
        .finally(() => setOcrChecking(false));
    }
  }, [currentPosition, charModelReady, template, videoRef, gpsRef, detectionsRef, latestOrientationRef, lastBlurScoreRef, blurBaselineRef, charModelRef, cropRatio]);

  const canAutoCapture =
    orientationOk && liveBlurOk && !needsDetection && !isFlipped &&
    !distanceHint && !horizontalHint && !verticalHint && stage === FLOW_STAGE.SHOOTING;

  const { stableCountdownActive } = useAutoCapture({
    status,
    stage,
    canAutoCapture,
    onCapture: () => takePhoto("auto"),
  });

  const confirmPhoto = useCallback(() => {
    if (!previewPhoto) return;
    if (plateMismatch && !IS_TEST_MODE) return;

    // 檢視「已完成角度」時按確認＝單純保留離開，不重複上傳
    if (previewPhoto.existing) {
      setPreviewPhoto(null);
      setOcrResult(null);
      setOcrChecking(false);
      const next = POSITION_SEQUENCE.find((p) => !capturedByPosition[p]);
      if (next) setCurrentPosition(next);
      setStage(FLOW_STAGE.SHOOTING);
      return;
    }

    const confirmedPosition = currentPosition;
    const meta = pendingMetaRef.current || {};
    const plateMatch = ocrResult ? ocrResult.text === normalizedPlateNumber : null;

    const photo = { 
        ...previewPhoto, 
        ocrResult,
        meta,
        plateMatch,
        position: confirmedPosition,
        sequenceIndex: POSITION_INDEX[confirmedPosition]
    };

    const updated = { ...capturedByPosition, [confirmedPosition]: photo };
    setCapturedByPosition(updated);

    setPreviewPhoto(null);
    setOcrResult(null);
    setOcrChecking(false);

    const allDone = POSITION_SEQUENCE.every((p) => updated[p]);
    if (allDone) {
      if (rentalIdRef.current) {
        const batchMetaList = POSITION_SEQUENCE.map((pos) => {
          const item = updated[pos];
          return {
            rentalId: rentalIdRef.current,
            sessionId: sessionIdRef.current,
            vehicleId: normalizedPlateNumber,
            carModel,
            personnelName,
            plateInput: plateNumberInput,
            plateInputNormalized: normalizedPlateNumber,
            sequenceIndex: POSITION_INDEX[pos],
            position: pos,
            dataUrl: item.dataUrl,
            plateOcr: item.ocrResult,
            plateMatch: item.plateMatch,
            ...(item.meta || {}),
          };
        });
        uploadBatchPhotosRecords(batchMetaList).catch((err) => console.error("上傳失敗（不擋流程）：", err));
      }
      setStage(FLOW_STAGE.ANALYZING);
    } else {
      const next = POSITION_SEQUENCE.find((p) => !updated[p]);
      setCurrentPosition(next);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [previewPhoto, plateMismatch, currentPosition, capturedByPosition, ocrResult, normalizedPlateNumber, personnelName, plateNumberInput, carModel, sessionIdRef]);

  const retakePhoto = useCallback(() => {
    retakeCountRef.current[currentPosition] = (retakeCountRef.current[currentPosition] || 0) + 1;
    setPreviewPhoto(null);
    setOcrResult(null);
    setOcrChecking(false);
    setStage(FLOW_STAGE.SHOOTING);
  }, [currentPosition]);

  // 點擊 compass 上任一角度：未拍 → 直接切去該角度拍攝；已拍 → 開啟該角度預覽（可確認保留或重拍）
  const selectPosition = useCallback((position) => {
    const stored = capturedByPosition[position];
    if (stored) {
      setPreviewPhoto({ ...stored, existing: true });
      setCurrentPosition(position);
      setOcrResult(stored.ocrResult || null);
      setOcrChecking(false);
      setStage(FLOW_STAGE.PREVIEW);
    } else {
      setCurrentPosition(position);
      setPreviewPhoto(null);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [capturedByPosition]);

  // ANALYZING → 實時持續監聽 40 秒或四張照片全數收齊（有車損或 none）後，切換至 ANALYSIS_DEBUG 驗證頁
  useEffect(() => {
    if (stage !== FLOW_STAGE.ANALYZING) return;

    setSecondsLeft(40);
    const countdownTimer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(countdownTimer);
          setStage(FLOW_STAGE.ANALYSIS_DEBUG);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    let unsub = () => {};
    if (rentalIdRef.current) {
      unsub = subscribeToRentalAnalysis(rentalIdRef.current, (update) => {
        if (update.type === "photos" && update.photosMap) {
          setCapturedByPosition((prev) => {
            const next = { ...prev };
            Object.keys(update.photosMap).forEach((pType) => {
              const photoData = update.photosMap[pType];
              let targetPosKey = POSITION_SEQUENCE.find(
                (posKey) =>
                  (next[posKey]?.fileName && next[posKey]?.fileName === photoData.file_name) ||
                  (next[posKey]?.file_name && next[posKey]?.file_name === photoData.file_name)
              );
              if (!targetPosKey) {
                targetPosKey = PHOTO_TYPE_TO_POSITION[pType] || pType;
              }

              if (next[targetPosKey]) {
                next[targetPosKey] = { ...next[targetPosKey], ...photoData };
              }
            });

            const allReceived = POSITION_SEQUENCE.every((p) => isPhotoReceived(next[p]));
            if (allReceived) {
              clearInterval(countdownTimer);
              setStage(FLOW_STAGE.ANALYSIS_DEBUG);
            }

            return next;
          });
        }
      });
    }

    return () => {
      clearInterval(countdownTimer);
      unsub();
    };
  }, [stage]);

  const startReview = useCallback(() => {
    setReviewIndex(0);
    setStage(FLOW_STAGE.REVIEWING);
  }, []);

  const confirmReviewPhoto = useCallback(() => {
    setReviewIndex((prev) => {
      if (prev >= capturedPhotos.length - 1) {
        setStage(FLOW_STAGE.DOWNLOAD_PROMPT);
        return prev;
      }
      return prev + 1;
    });
  }, [capturedPhotos.length]);

  const handleDownloadConfirm = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    const result = await trySharePhotos(capturedPhotos);
    setIsSharing(false);
    if (result === "shared") setStage(FLOW_STAGE.COMPLETE);
    else if (result === "cancelled") { /* 停留，可重試 */ }
    else setStage(FLOW_STAGE.MANUAL_SAVE);
  }, [capturedPhotos, isSharing]);

  const resetSharedState = useCallback(() => {
    setCurrentPosition(POSITION_SEQUENCE[0]);
    setCapturedByPosition({});
    setPreviewPhoto(null);
    setOcrResult(null);
    setOcrChecking(false);
    setReviewIndex(0);
    setIsSharing(false);
    retakeCountRef.current = {};
    pendingMetaRef.current = null;
  }, []);

  const resetFlow = useCallback(() => {
    // 同一台車重新檢測：新 session + 新訂單
    sessionIdRef.current = generateSessionId();
    rentalIdRef.current = null;
    resetSharedState();
    setStage(FLOW_STAGE.SHOOTING);
    setStatus(CAMERA_STATUS.GRANTED);
  }, [resetSharedState, sessionIdRef, setStatus]);

  const backToStart = useCallback(() => {
    stopStream();
    sessionIdRef.current = null;
    rentalIdRef.current = null;
    resetSharedState();
    setStage(FLOW_STAGE.SHOOTING);
    setStatus(CAMERA_STATUS.IDLE);
    setPersonnelName("");
    setPlateNumberInput("");
  }, [stopStream, resetSharedState, sessionIdRef, setStatus]);

  const reviewPhoto = capturedPhotos[reviewIndex];
  const rawW = videoRef.current?.videoWidth;
  const rawH = videoRef.current?.videoHeight;
  const blurScore = useMemo(() => lastBlurScoreRef.current, [detections, lastBlurScoreRef]); // 隨偵測更新

  return (
    <div style={styles.page}>
      <canvas ref={inputCanvasRef} width={640} height={640} style={{ display: "none" }} />

      {(status === CAMERA_STATUS.IDLE ||
        status === CAMERA_STATUS.REQUESTING ||
        status === CAMERA_STATUS.DENIED ||
        status === CAMERA_STATUS.UNSUPPORTED ||
        status === CAMERA_STATUS.ERROR) && (
        <StartScreen
          status={status}
          carModel={carModel}
          onCarModelChange={(e) => setCarModel(e.target.value)}
          personnelName={personnelName}
          plateNumberInput={plateNumberInput}
          aspectRatio={cropRatio}
          onAspectRatioChange={(e) => setCropRatio(e.target.value)}
          onPersonnelChange={handlePersonnelChange}
          onPlateChange={handlePlateChange}
          canStart={canStart}
          onStart={handleStart}
        />
      )}

      {/* 【相機穩定性修正】SHOOTING/PREVIEW 都保留 video 掛載，避免每次拍照都
          unmount+remount <video>、對同一條 MediaStream track 反覆重新 attach。
          這種反覆 attach 在部分 WebKit 版本會在數次後讓畫面卡在最後一幀不再更新
          （track 本身仍是 live，只是不再繪製），且無法自行恢復；PREVIEW 用不透明
          的 PreviewScreen 蓋在上面即可，不需要真的把 video 拆掉。 */}
      {status === CAMERA_STATUS.GRANTED && (stage === FLOW_STAGE.SHOOTING || stage === FLOW_STAGE.PREVIEW) && (
        <Viewfinder
          videoRef={videoRef}
          template={template}
          carModel={carModel}
          cropRatio={cropRatio}
          position={currentPosition}
          currentPosition={currentPosition}
          capturedByPosition={capturedByPosition}
          onSelectPosition={selectPosition}
          modelReady={modelReady}
          modelError={modelError}
          detections={detections}
          isFlipped={isFlipped}
          orientationOk={orientationOk}
          orientationIssues={orientationIssues}
          liveBlurOk={liveBlurOk}
          needsDetection={needsDetection}
          distanceHint={distanceHint}
          horizontalHint={horizontalHint}
          verticalHint={verticalHint}
          stableCountdownActive={stableCountdownActive}
          ready={canAutoCapture}
          rawW={rawW}
          rawH={rawH}
          blurScore={blurScore}
          onManualCapture={() => takePhoto("manual")}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.PREVIEW && previewPhoto && (
        <PreviewScreen
          previewPhoto={previewPhoto}
          positionLabel={GUIDE_TEMPLATES[previewPhoto.position]?.label}
          ocrChecking={ocrChecking}
          ocrResult={ocrResult}
          plateMismatch={plateMismatch}
          normalizedPlateNumber={normalizedPlateNumber}
          onRetake={retakePhoto}
          onConfirm={confirmPhoto}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.ANALYZING && (
        <AnalyzingScreen
          secondsLeft={secondsLeft}
          receivedCount={receivedCount}
          onSkip={() => setStage(FLOW_STAGE.ANALYSIS_DEBUG)}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.ANALYSIS_DEBUG && (
        <AnalysisDebugScreen
          capturedByPosition={capturedByPosition}
          onNext={() => setStage(FLOW_STAGE.REVIEW_INTRO)}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.REVIEW_INTRO && (
        <ReviewIntroScreen onStart={startReview} />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.REVIEWING && reviewPhoto && (
        <ReviewScreen
          reviewPhoto={reviewPhoto}
          positionLabel={GUIDE_TEMPLATES[reviewPhoto.position]?.label}
          reviewIndex={reviewIndex}
          total={capturedPhotos.length}
          onConfirm={confirmReviewPhoto}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.DOWNLOAD_PROMPT && (
        <DownloadPromptScreen
          isSharing={isSharing}
          onYes={handleDownloadConfirm}
          onNo={() => setStage(FLOW_STAGE.COMPLETE)}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.MANUAL_SAVE && (
        <ManualSaveScreen photos={capturedPhotos} cropRatio={cropRatio} onDone={() => setStage(FLOW_STAGE.COMPLETE)} />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.COMPLETE && (
        <CompleteScreen photos={capturedPhotos} cropRatio={cropRatio} onBackToStart={backToStart} onRestart={resetFlow} />
      )}
    </div>
  );
}

const styles = {
  page: {
    position: "relative",
    width: "100vw",
    height: "100dvh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
    overflow: "hidden",
  },
};

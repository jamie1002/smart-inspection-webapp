// 流程狀態機協調器（取代舊 CameraModule）
// 只組合 hooks、持有 stage、決定渲染哪支畫面元件；不含演算法。
import { useState, useRef, useEffect, useCallback, useMemo } from "react";

import { CAMERA_STATUS, FLOW_STAGE } from "../constants/flow";
import {
  POSITION_SEQUENCE,
  GUIDE_TEMPLATES,
} from "../constants/guideTemplates";
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
import { createRental, uploadPhotoRecord, markPickupUploaded } from "../services/upload";

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
import ReviewIntroScreen from "./camera/ReviewIntroScreen";
import ReviewScreen from "./camera/ReviewScreen";
import DownloadPromptScreen from "./camera/DownloadPromptScreen";
import ManualSaveScreen from "./camera/ManualSaveScreen";
import CompleteScreen from "./camera/CompleteScreen";
import { colors } from "../styles/theme";

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
  const [positionIndex, setPositionIndex] = useState(0);
  const [capturedPhotos, setCapturedPhotos] = useState([]);
  const [previewPhoto, setPreviewPhoto] = useState(null);
  const [ocrResult, setOcrResult] = useState(null);
  const [ocrChecking, setOcrChecking] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [isSharing, setIsSharing] = useState(false);

  const [personnelName, setPersonnelName] = useState("");
  const [plateNumberInput, setPlateNumberInput] = useState("");

  const currentPosition = POSITION_SEQUENCE[positionIndex];
  const template = GUIDE_TEMPLATES[currentPosition];

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
      personnelName,
      plateInput: plateNumberInput,
      plateInputNormalized: vehicleId,
    })
      .then((id) => { rentalIdRef.current = id; })
      .catch((err) => console.error("建立訂單失敗（可忽略，不擋流程）：", err));
  }, [status, plateNumberInput, personnelName, sessionIdRef]);

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
    const { cropW, cropH } = computeDisplayCropGeometry(rawW, rawH);

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
      recognizePlateCharacters(charModelRef.current, outputCanvas, detSnapshot["license_plate"])
        .then((result) => { if (result) setOcrResult(result); })
        .catch((err) => console.error("字元辨識發生錯誤：", err))
        .finally(() => setOcrChecking(false));
    }
  }, [currentPosition, charModelReady, videoRef, gpsRef, detectionsRef, latestOrientationRef, lastBlurScoreRef, blurBaselineRef, charModelRef]);

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
    if (!previewPhoto || plateMismatch) return;
    const photo = previewPhoto;
    const confirmedIndex = positionIndex;
    const meta = pendingMetaRef.current || {};
    const plateMatch = ocrResult ? ocrResult.text === normalizedPlateNumber : null;

    setCapturedPhotos((prev) => [...prev, photo]);

    if (rentalIdRef.current) {
      uploadPhotoRecord({
        rentalId: rentalIdRef.current,
        sessionId: sessionIdRef.current,
        vehicleId: normalizedPlateNumber,
        personnelName,
        plateInput: plateNumberInput,
        plateInputNormalized: normalizedPlateNumber,
        sequenceIndex: confirmedIndex,
        dataUrl: photo.dataUrl,
        plateOcr: ocrResult,
        plateMatch,
        ...meta,
      }).catch((err) => console.error("上傳失敗（不擋流程）：", err));
    }

    setPreviewPhoto(null);
    setOcrResult(null);
    setOcrChecking(false);

    if (confirmedIndex >= POSITION_SEQUENCE.length - 1) {
      if (rentalIdRef.current) markPickupUploaded(rentalIdRef.current).catch(() => {});
      setStage(FLOW_STAGE.ANALYZING);
    } else {
      setPositionIndex(confirmedIndex + 1);
      setStage(FLOW_STAGE.SHOOTING);
    }
  }, [previewPhoto, plateMismatch, positionIndex, ocrResult, normalizedPlateNumber, personnelName, plateNumberInput, sessionIdRef]);

  const retakePhoto = useCallback(() => {
    retakeCountRef.current[currentPosition] = (retakeCountRef.current[currentPosition] || 0) + 1;
    setPreviewPhoto(null);
    setOcrResult(null);
    setOcrChecking(false);
    setStage(FLOW_STAGE.SHOOTING);
  }, [currentPosition]);

  // ANALYZING → REVIEW_INTRO
  useEffect(() => {
    if (stage !== FLOW_STAGE.ANALYZING) return;
    const timerId = setTimeout(() => setStage(FLOW_STAGE.REVIEW_INTRO), ANALYZING_DURATION_MS);
    return () => clearTimeout(timerId);
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
    setPositionIndex(0);
    setCapturedPhotos([]);
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
          personnelName={personnelName}
          plateNumberInput={plateNumberInput}
          onPersonnelChange={handlePersonnelChange}
          onPlateChange={handlePlateChange}
          canStart={canStart}
          onStart={handleStart}
        />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.SHOOTING && (
        <Viewfinder
          videoRef={videoRef}
          template={template}
          positionIndex={positionIndex}
          completedCount={capturedPhotos.length}
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

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.ANALYZING && <AnalyzingScreen />}

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
        <ManualSaveScreen photos={capturedPhotos} onDone={() => setStage(FLOW_STAGE.COMPLETE)} />
      )}

      {status === CAMERA_STATUS.GRANTED && stage === FLOW_STAGE.COMPLETE && (
        <CompleteScreen photos={capturedPhotos} onBackToStart={backToStart} onRestart={resetFlow} />
      )}
    </div>
  );
}

const styles = {
  page: {
    width: "100vw",
    height: "100dvh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
    overflow: "hidden",
  },
};

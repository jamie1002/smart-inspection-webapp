// 推論迴圈：定時跑車體定位 → 更新偵測框與位置/距離提示
// 行為沿用 CameraModule 的 runInference，運算搬到 services/models。
import { useState, useRef, useEffect, useCallback } from "react";
import { CAMERA_STATUS, FLOW_STAGE } from "../constants/flow";
import { INFERENCE_INTERVAL_MS } from "../constants/detection";
import { runCarDetection } from "../services/models";
import { evaluateAlignment, evaluatePositionAndDistance } from "../utils/alignment";

export function useInference({
    status,
    modelReady,
    stage,
    currentPosition,
    templates,
    cropRatio,
    videoRef,
    carModelRef,
    inputCanvasRef,
    orientationOkRef,
}) {
    const [inferenceState, setInferenceState] = useState({
        detections: {},
        needsDetection: true,
        distanceHint: null,
        horizontalHint: null,
        verticalHint: null,
        isFlipped: false,
    });

    const detectionsRef = useRef({});
    const stageRef = useRef(stage);
    const intervalRef = useRef(null);
    const isInferringRef = useRef(false);

    useEffect(() => {
        detectionsRef.current = inferenceState.detections;
    }, [inferenceState.detections]);

    useEffect(() => {
        stageRef.current = stage;
    }, [stage]);

    const runInference = useCallback(async () => {
        if (isInferringRef.current) return;

        if (!orientationOkRef.current || stageRef.current !== FLOW_STAGE.SHOOTING) {
            setInferenceState((prev) => {
                if (!prev.needsDetection && Object.keys(prev.detections).length === 0) return prev;
                return {
                    detections: {},
                    needsDetection: true,
                    distanceHint: null,
                    horizontalHint: null,
                    verticalHint: null,
                    isFlipped: false,
                };
            });
            return;
        }

        const video = videoRef.current;
        const model = carModelRef.current;
        const canvas = inputCanvasRef.current;
        if (!video || !model || !canvas || video.readyState < 2) return;
        if (!video.videoWidth || !video.videoHeight) return;

        isInferringRef.current = true;
        try {
            const rawResults = await runCarDetection(video, model, canvas, cropRatio);

            if (stageRef.current !== FLOW_STAGE.SHOOTING) return;

            const newDetections = evaluateAlignment(rawResults, currentPosition, templates);
            const { distanceHint, horizontalHint, verticalHint, isFlipped, incomplete } =
                evaluatePositionAndDistance(rawResults, currentPosition, templates);

            setInferenceState({
                detections: newDetections,
                needsDetection: incomplete,
                distanceHint,
                horizontalHint,
                verticalHint,
                isFlipped,
            });
        } catch (err) {
            console.error("推論過程中發生錯誤：", err);
        } finally {
            isInferringRef.current = false;
        }
    }, [currentPosition, templates, cropRatio, videoRef, carModelRef, inputCanvasRef, orientationOkRef]);

    useEffect(() => {
        if (status !== CAMERA_STATUS.GRANTED || !modelReady || stage !== FLOW_STAGE.SHOOTING) return;
        intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
        return () => clearInterval(intervalRef.current);
    }, [status, modelReady, stage, runInference]);

    return {
        detections: inferenceState.detections,
        detectionsRef,
        needsDetection: inferenceState.needsDetection,
        distanceHint: inferenceState.distanceHint,
        horizontalHint: inferenceState.horizontalHint,
        verticalHint: inferenceState.verticalHint,
        isFlipped: inferenceState.isFlipped,
    };
}
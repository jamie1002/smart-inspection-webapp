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
    const [detections, setDetections] = useState({});
    const [needsDetection, setNeedsDetection] = useState(true);
    const [distanceHint, setDistanceHint] = useState(null);
    const [horizontalHint, setHorizontalHint] = useState(null);
    const [verticalHint, setVerticalHint] = useState(null);
    const [isFlipped, setIsFlipped] = useState(false);

    const detectionsRef = useRef({});
    const stageRef = useRef(stage);
    const intervalRef = useRef(null);

    useEffect(() => {
        detectionsRef.current = detections;
    }, [detections]);

    useEffect(() => {
        stageRef.current = stage;
    }, [stage]);

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
        const model = carModelRef.current;
        const canvas = inputCanvasRef.current;
        if (!video || !model || !canvas || video.readyState < 2) return;
        if (!video.videoWidth || !video.videoHeight) return;

        const rawResults = runCarDetection(video, model, canvas, cropRatio);

        setDetections(evaluateAlignment(rawResults, currentPosition, templates));

        const { distanceHint, horizontalHint, verticalHint, isFlipped, incomplete } =
            evaluatePositionAndDistance(rawResults, currentPosition, templates);
        setDistanceHint(distanceHint);
        setHorizontalHint(horizontalHint);
        setVerticalHint(verticalHint);
        setIsFlipped(isFlipped);
        setNeedsDetection(incomplete);
    }, [currentPosition, templates, cropRatio, videoRef, carModelRef, inputCanvasRef, orientationOkRef]);

    useEffect(() => {
        if (status !== CAMERA_STATUS.GRANTED || !modelReady || stage !== FLOW_STAGE.SHOOTING) return;
        intervalRef.current = setInterval(runInference, INFERENCE_INTERVAL_MS);
        return () => clearInterval(intervalRef.current);
    }, [status, modelReady, stage, runInference]);

    return {
        detections,
        detectionsRef,
        needsDetection,
        distanceHint,
        horizontalHint,
        verticalHint,
        isFlipped,
    };
}
// 即時模糊偵測 + EMA 漸進基準，行為沿用 CameraModule 不變
// 額外暴露最新分數/基準的 ref，供上傳 metadata 記錄模糊程度。
import { useState, useRef, useEffect } from "react";
import { CAMERA_STATUS } from "../constants/flow";
import {
  LIVE_BLUR_CHECK_INTERVAL_MS,
  LIVE_BLUR_SAMPLE_WIDTH,
  LIVE_BLUR_STABLE_SAMPLES,
  BLUR_BASELINE_MIN_SAMPLES,
  BLUR_BASELINE_EMA_ALPHA,
  BLUR_RELATIVE_RATIO,
} from "../constants/detection";
import { calculateBlurScore } from "../utils/blur";

export function useLiveBlur(status, videoRef) {
  const [liveBlurOk, setLiveBlurOk] = useState(true);
  const liveBlurOkRef = useRef(true);

  const blurBaselineRef = useRef(null);
  const blurSampleCountRef = useRef(0);
  const consecutiveBlurOkRef = useRef(0);
  const lastBlurScoreRef = useRef(null);

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
      lastBlurScoreRef.current = score;
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
  }, [status, videoRef]);

  return { liveBlurOk, liveBlurOkRef, blurBaselineRef, lastBlurScoreRef };
}

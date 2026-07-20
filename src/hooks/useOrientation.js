// 陀螺儀雙軸防呆（beta/gamma），行為沿用 CameraModule 不變
import { useState, useRef, useEffect } from "react";
import { CAMERA_STATUS } from "../constants/flow";
import {
  GAMMA_THRESHOLD,
  BETA_MIN,
  BETA_MAX,
  ORIENTATION_THROTTLE_MS,
  ORIENTATION_STABLE_SAMPLES,
} from "../constants/detection";

export function useOrientation(status) {
  const [orientationOk, setOrientationOk] = useState(true);
  const [orientationIssues, setOrientationIssues] = useState({ betaBad: false, gammaBad: false });

  const orientationOkRef = useRef(true);
  const latestOrientationRef = useRef({ beta: null, gamma: null });
  const lastCheckRef = useRef(0);
  const consecutiveNormalRef = useRef(0);

  useEffect(() => {
    if (status !== CAMERA_STATUS.GRANTED) return;

    const handleOrientation = (event) => {
      const now = Date.now();
      if (now - lastCheckRef.current < ORIENTATION_THROTTLE_MS) return;
      lastCheckRef.current = now;

      const { beta, gamma } = event;
      if (beta === null || gamma === null) return;
      latestOrientationRef.current = { beta, gamma };

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

  return { orientationOk, orientationIssues, orientationOkRef, latestOrientationRef };
}

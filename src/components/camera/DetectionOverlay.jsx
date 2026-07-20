// 模型偵測框（綠=對齊 / 橘=未對齊）
// ⚠️ 測試版限定：僅在 IS_TEST_MODE 為真時由 Viewfinder 掛載，正式版不渲染。
import { colors } from "../../styles/theme";

export default function DetectionOverlay({ detections }) {
  return (
    <svg style={styles.overlay} preserveAspectRatio="none">
      {Object.entries(detections).map(([key, det]) => (
        <rect
          key={key}
          x={`${det.xMinPct}%`}
          y={`${det.yMinPct}%`}
          width={`${det.xMaxPct - det.xMinPct}%`}
          height={`${det.yMaxPct - det.yMinPct}%`}
          fill="none"
          stroke={det.aligned ? colors.detectAligned : colors.detectMisaligned}
          strokeWidth="3"
        />
      ))}
    </svg>
  );
}

const styles = {
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
};

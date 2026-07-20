// 引導框（車牌/輪胎虛線框）— 正式版與測試版皆顯示，屬取景必要輔助
import { colors } from "../../styles/theme";

export default function GuideOverlay({ template }) {
  if (!template) return null;
  return (
    <svg style={styles.overlay} preserveAspectRatio="none">
      <rect
        x={`${template.licensePlate.xMin}%`}
        y={`${template.licensePlate.yMin}%`}
        width={`${template.licensePlate.xMax - template.licensePlate.xMin}%`}
        height={`${template.licensePlate.yMax - template.licensePlate.yMin}%`}
        fill="none"
        stroke={colors.guideStroke}
        strokeWidth="2"
        strokeDasharray="6,4"
        strokeOpacity="0.6"
      />
      <rect
        x={`${template.wheel.xMin}%`}
        y={`${template.wheel.yMin}%`}
        width={`${template.wheel.xMax - template.wheel.xMin}%`}
        height={`${template.wheel.yMax - template.wheel.yMin}%`}
        fill="none"
        stroke={colors.guideStroke}
        strokeWidth="2"
        strokeDasharray="6,4"
        strokeOpacity="0.6"
      />
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

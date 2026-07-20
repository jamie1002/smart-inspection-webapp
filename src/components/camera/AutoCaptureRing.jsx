// 正式版自動拍照能量環
// - 未對齊：灰環 + 「自動拍照」
// - 對齊（ready）：轉綠色
// - 穩定等待期（counting）：綠色進度弧像能量條，於 durationMs 內充滿，充滿即拍照
import { colors, font } from "../../styles/theme";

const R = 32;
const C = 2 * Math.PI * R;

export default function AutoCaptureRing({ ready, counting, durationMs }) {
  const activeColor = ready ? colors.success : "rgba(255,255,255,0.7)";
  const animName = "acr-fill";

  return (
    <div style={styles.wrap}>
      <style>{`@keyframes ${animName}{from{stroke-dashoffset:${C};}to{stroke-dashoffset:0;}}`}</style>
      <svg width="72" height="72" viewBox="0 0 72 72" style={styles.svg}>
        {/* 軌道 */}
        <circle cx="36" cy="36" r={R} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="4" />
        {/* 進度弧（能量條），counting 時才動畫 */}
        <circle
          key={counting ? "run" : "idle"}
          cx="36"
          cy="36"
          r={R}
          fill="none"
          stroke={colors.success}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={counting ? undefined : C}
          transform="rotate(-90 36 36)"
          style={
            counting
              ? { animation: `${animName} ${durationMs}ms linear forwards` }
              : { strokeDashoffset: C }
          }
        />
      </svg>
      <span style={{ ...styles.label, color: activeColor }}>自動拍照</span>
    </div>
  );
}

const styles = {
  wrap: {
    position: "absolute",
    bottom: 32,
    left: "50%",
    transform: "translateX(-50%)",
    width: 72,
    height: 72,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 30,
  },
  svg: { position: "absolute", inset: 0 },
  label: { fontSize: font.xs, fontWeight: 700, letterSpacing: 0.5 },
};

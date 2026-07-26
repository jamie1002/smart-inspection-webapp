// 分析中（ANALYZING）：實時持續監聽 40 秒或全數收齊
// onSkip 由 CameraFlow 依 IS_TEST_MODE 決定是否傳入：測試版才提供「直接進入車損確認」捷徑
import { colors, space, font, radius } from "../../styles/theme";

export default function AnalyzingScreen({ secondsLeft = 40, receivedCount = 0, onSkip }) {
  return (
    <div style={styles.center}>
      <div style={styles.spinnerWrap}>
        <div style={styles.spinner} />
        <span style={styles.spinnerCount}>{secondsLeft}</span>
      </div>
      <p style={styles.text}>AI 分析中</p>

      <div style={styles.statusBox}>
        <p style={styles.progressText}>
          分析完成:<span style={styles.highlight}>{receivedCount}/4</span>張
        </p>
      </div>

      {onSkip && (
        <button style={styles.skipBtn} onClick={onSkip}>
          直接進入車損確認 ➔
        </button>
      )}
      <style>{keyframes}</style>
    </div>
  );
}

const keyframes = `@keyframes spin{to{transform:rotate(360deg)}}`;

const styles = {
  center: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
    gap: space.md,
    padding: space.lg,
    boxSizing: "border-box",
  },
  spinnerWrap: {
    position: "relative",
    width: 56,
    height: 56,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  spinner: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    border: `4px solid ${colors.border}`,
    borderTopColor: colors.brand,
    animation: "spin 0.9s linear infinite",
  },
  spinnerCount: {
    position: "relative",
    color: "#ff4d4f",
    fontWeight: 700,
    fontSize: font.sm,
  },
  text: { color: "#fff", fontSize: font.lg, fontWeight: 700, textAlign: "center", maxWidth: 320, lineHeight: 1.6 },
  statusBox: {
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    padding: "10px 16px",
    textAlign: "center",
    margin: "4px 0",
  },
  progressText: { color: colors.textSecondary, fontSize: font.sm, margin: "2px 0" },
  highlight: { color: "#ff4d4f", fontWeight: 700, fontSize: font.md },
  skipBtn: {
    marginTop: space.md,
    padding: "8px 18px",
    fontSize: font.sm,
    color: colors.textSecondary,
    backgroundColor: "transparent",
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    cursor: "pointer",
  },
};

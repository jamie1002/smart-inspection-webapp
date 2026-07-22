// 分析中（ANALYZING）：實時持續監聽 40 秒或全數收齊
import { colors, space, font, radius } from "../../styles/theme";

export default function AnalyzingScreen({ secondsLeft = 40, receivedCount = 0, onSkip }) {
  return (
    <div style={styles.center}>
      <div style={styles.spinner} />
      <p style={styles.text}>後端 AI 分析車損中…</p>

      <div style={styles.statusBox}>
        <p style={styles.timerText}>實時持續監聽剩餘：<span style={styles.highlight}>{secondsLeft} 秒</span></p>
        <p style={styles.progressText}>四方位照片收集進度：<span style={styles.highlight}>{receivedCount} / 4</span> 張</p>
      </div>

      <p style={styles.subtext}>
        照片已同步上傳至 Firebase，將持續接收 40 秒或等四張照片皆收齊 AI 回覆（車損座標或 none）後跳轉。
      </p>

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
  spinner: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    border: `4px solid ${colors.border}`,
    borderTopColor: colors.brand,
    animation: "spin 0.9s linear infinite",
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
  timerText: { color: colors.textSecondary, fontSize: font.sm, margin: "2px 0" },
  progressText: { color: colors.textSecondary, fontSize: font.sm, margin: "2px 0" },
  highlight: { color: "#ff4d4f", fontWeight: 700, fontSize: font.md },
  subtext: { color: colors.textSecondary, fontSize: font.xs, textAlign: "center", maxWidth: 320, lineHeight: 1.5 },
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

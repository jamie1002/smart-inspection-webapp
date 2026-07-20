// 分析中（ANALYZING）：模擬等待後端 AI 辨識
import { colors, space, font } from "../../styles/theme";

export default function AnalyzingScreen() {
  return (
    <div style={styles.center}>
      <div style={styles.spinner} />
      <p style={styles.text}>請稍候，AI 辨識目前車況中…</p>
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
    gap: space.lg,
    padding: space.lg,
    boxSizing: "border-box",
  },
  spinner: {
    width: 44,
    height: 44,
    borderRadius: "50%",
    border: `4px solid ${colors.border}`,
    borderTopColor: colors.brand,
    animation: "spin 0.9s linear infinite",
  },
  text: { color: "#fff", fontSize: font.lg, fontWeight: 700, textAlign: "center", maxWidth: 300, lineHeight: 1.6 },
};

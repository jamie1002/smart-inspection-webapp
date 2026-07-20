// 完成（COMPLETE）：四張縮圖 + 回到最開始 / 重新檢測
import { GUIDE_TEMPLATES } from "../../constants/guideTemplates";
import { colors, space, radius, font, primaryButton, secondaryButton } from "../../styles/theme";

export default function CompleteScreen({ photos, onBackToStart, onRestart }) {
  return (
    <div style={styles.container}>
      <div style={styles.check}>✓</div>
      <p style={styles.title}>四個角度拍攝完成</p>
      <div style={styles.grid}>
        {photos.map((p) => (
          <div key={p.position} style={styles.item}>
            <img src={p.dataUrl} alt={p.position} style={styles.thumb} />
            <span style={styles.thumbLabel}>{GUIDE_TEMPLATES[p.position]?.label}</span>
          </div>
        ))}
      </div>
      <div style={styles.buttonRow}>
        <button style={secondaryButton} onClick={onBackToStart}>回到最開始</button>
        <button style={primaryButton} onClick={onRestart}>重新檢測</button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    justifyContent: "flex-start",
    alignItems: "center",
    backgroundColor: colors.bg,
    gap: space.md,
    padding: space.lg,
    overflowY: "auto",
    boxSizing: "border-box",
  },
  check: {
    width: 48,
    height: 48,
    borderRadius: "50%",
    backgroundColor: colors.successSoft,
    color: colors.success,
    fontSize: font.xl,
    fontWeight: 800,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    marginTop: space.sm,
  },
  title: { color: "#fff", fontSize: font.lg, fontWeight: 700 },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, width: "100%", maxWidth: 280 },
  item: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  thumb: { width: "100%", borderRadius: radius.sm, aspectRatio: "9 / 16", objectFit: "cover" },
  thumbLabel: { color: colors.textSecondary, fontSize: font.sm },
  buttonRow: { display: "flex", gap: space.md, marginTop: space.sm, paddingBottom: space.md },
};

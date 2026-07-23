// 完成（COMPLETE）：四張縮圖 + 車損標記重疊 + 回到最開始 / 重新檢測
import { GUIDE_TEMPLATES } from "../../constants/guideTemplates";
import { colors, space, font, primaryButton, secondaryButton } from "../../styles/theme";
import DamageThumbnail from "./DamageThumbnail";

export default function CompleteScreen({ photos, cropRatio, onBackToStart, onRestart }) {
  return (
    <div style={styles.container}>
      <div style={styles.check}>✓</div>
      <p style={styles.title}>四個角度拍攝完成</p>
      <div style={styles.grid}>
        {photos.map((p) => (
          <DamageThumbnail
            key={p.position}
            photo={p}
            positionLabel={GUIDE_TEMPLATES[p.position]?.label}
            cropRatio={cropRatio}
          />
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
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, width: "100%", maxWidth: 320 },
  buttonRow: { display: "flex", gap: space.md, marginTop: space.sm, paddingBottom: space.md },
};

// 手動儲存引導（MANUAL_SAVE）：裝置不支援 navigator.share 時降級
import { GUIDE_TEMPLATES } from "../../constants/guideTemplates";
import { colors, space, radius, font, primaryButton } from "../../styles/theme";

export default function ManualSaveScreen({ photos, onDone }) {
  return (
    <div style={styles.container}>
      <p style={styles.title}>此裝置無法自動跳出儲存選單</p>
      <p style={styles.hint}>請依序長按下方每張照片，選擇「儲存影像」或「加入照片」，即可存進手機相簿</p>
      <div style={styles.grid}>
        {photos.map((p) => (
          <div key={p.position} style={styles.item}>
            <img src={p.dataUrl} alt={p.position} style={styles.thumb} />
            <span style={styles.thumbLabel}>{GUIDE_TEMPLATES[p.position]?.label}</span>
          </div>
        ))}
      </div>
      <button style={primaryButton} onClick={onDone}>已完成儲存</button>
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
  title: { color: "#fff", fontSize: font.lg, fontWeight: 700, textAlign: "center" },
  hint: { color: colors.textSecondary, fontSize: font.md, lineHeight: 1.6, maxWidth: 300, textAlign: "center" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, width: "100%", maxWidth: 280 },
  item: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  thumb: { width: "100%", borderRadius: radius.sm, aspectRatio: "9 / 16", objectFit: "cover" },
  thumbLabel: { color: colors.textSecondary, fontSize: font.sm },
};

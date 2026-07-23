// 手動儲存引導（MANUAL_SAVE）：裝置不支援 navigator.share 時降級
import { GUIDE_TEMPLATES } from "../../constants/guideTemplates";
import { colors, space, font, primaryButton } from "../../styles/theme";
import DamageThumbnail from "./DamageThumbnail";

export default function ManualSaveScreen({ photos, cropRatio, onDone }) {
  return (
    <div style={styles.container}>
      <p style={styles.title}>此裝置無法自動跳出儲存選單</p>
      <p style={styles.hint}>請依序長按下方每張照片，選擇「儲存影像」或「加入照片」，即可存進手機相簿</p>
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
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.md, width: "100%", maxWidth: 320 },
};

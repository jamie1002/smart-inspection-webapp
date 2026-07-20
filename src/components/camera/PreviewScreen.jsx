// 拍照預覽（PREVIEW）：3:4 顯示層裁切 + 車牌辨識比對
// 實際存檔/上傳仍為完整 9:16，這裡只是顯示裁切。
import { IS_TEST_MODE } from "../../config/appConfig";
import { colors, space, radius, font, primaryButton, secondaryButton, disabledButton } from "../../styles/theme";

export default function PreviewScreen({
  previewPhoto,
  positionLabel,
  ocrChecking,
  ocrResult,
  plateMismatch,
  normalizedPlateNumber,
  onRetake,
  onConfirm,
}) {
  return (
    <div style={styles.container}>
      <div style={styles.frame}>
        <img src={previewPhoto.dataUrl} alt="拍攝預覽" style={styles.img} />
      </div>
      <div style={styles.label}>{positionLabel}</div>

      {ocrChecking && <div style={styles.sub}>車牌辨識中…</div>}

      {!ocrChecking && ocrResult && IS_TEST_MODE && (
        <div style={styles.sub}>
          車牌辨識：{ocrResult.text}（信心 {ocrResult.confidence.toFixed(2)}）
        </div>
      )}
      {!ocrChecking && ocrResult && !IS_TEST_MODE && !plateMismatch && (
        <div style={{ ...styles.sub, color: colors.success }}>車牌相符 ✓</div>
      )}

      {!ocrChecking && plateMismatch && (
        <div style={styles.mismatch}>
          辨識車牌「{ocrResult.text}」與輸入車牌「{normalizedPlateNumber}」不符，
          請確認拍攝車輛是否正確後重新拍攝
        </div>
      )}

      <div style={styles.buttonRow}>
        <button style={secondaryButton} onClick={onRetake}>重新拍攝</button>
        {!plateMismatch && (
          <button
            style={{ ...primaryButton, ...(ocrChecking ? disabledButton : {}) }}
            onClick={onConfirm}
            disabled={ocrChecking}
          >
            {ocrChecking ? "辨識中…" : "確認保留"}
          </button>
        )}
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
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
    gap: space.md,
    padding: space.lg,
    boxSizing: "border-box",
  },
  frame: {
    width: "100%",
    maxWidth: 300,
    aspectRatio: "3 / 4",
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  img: { width: "100%", height: "100%", objectFit: "cover" },
  label: { color: "#fff", fontSize: font.lg, fontWeight: 700 },
  sub: { color: colors.textSecondary, fontSize: font.md },
  mismatch: {
    color: colors.danger,
    fontSize: font.md,
    fontWeight: 700,
    lineHeight: 1.6,
    maxWidth: 300,
    textAlign: "center",
  },
  buttonRow: { display: "flex", gap: space.md },
};

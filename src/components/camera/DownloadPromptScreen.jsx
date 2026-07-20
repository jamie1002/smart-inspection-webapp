// 詢問是否儲存到相簿（DOWNLOAD_PROMPT）
import { colors, space, font, primaryButton, secondaryButton, disabledButton } from "../../styles/theme";

export default function DownloadPromptScreen({ isSharing, onYes, onNo }) {
  return (
    <div style={styles.center}>
      <p style={styles.text}>是否要將照片儲存到手機相簿？</p>
      <div style={styles.buttonRow}>
        <button style={{ ...secondaryButton, ...(isSharing ? disabledButton : {}) }} onClick={onNo} disabled={isSharing}>
          否
        </button>
        <button style={{ ...primaryButton, ...(isSharing ? disabledButton : {}) }} onClick={onYes} disabled={isSharing}>
          {isSharing ? "處理中…" : "是"}
        </button>
      </div>
    </div>
  );
}

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
  text: { color: "#fff", fontSize: font.lg, fontWeight: 700, textAlign: "center", maxWidth: 300 },
  buttonRow: { display: "flex", gap: space.md },
};

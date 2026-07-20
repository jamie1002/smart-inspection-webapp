// 車損比對前導（REVIEW_INTRO）
import { colors, space, font, primaryButton } from "../../styles/theme";

export default function ReviewIntroScreen({ onStart }) {
  return (
    <div style={styles.center}>
      <p style={styles.text}>請比對標記的車損是否與現場相符</p>
      <button style={primaryButton} onClick={onStart}>開始確認</button>
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
  text: { color: "#fff", fontSize: font.lg, fontWeight: 700, textAlign: "center", maxWidth: 300, lineHeight: 1.6 },
};

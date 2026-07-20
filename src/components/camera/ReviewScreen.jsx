// 逐張車損比對（REVIEWING）
import { colors, font, radius, primaryButton } from "../../styles/theme";

export default function ReviewScreen({ reviewPhoto, positionLabel, reviewIndex, total, onConfirm }) {
  return (
    <div style={styles.container}>
      <img src={reviewPhoto.dataUrl} alt="車損標記比對" style={styles.img} />
      <div style={styles.badge}>{positionLabel}（第 {reviewIndex + 1} / {total} 張）</div>
      <button style={{ ...primaryButton, ...styles.confirm }} onClick={onConfirm}>確認無誤</button>
    </div>
  );
}

const styles = {
  container: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  img: { width: "100%", height: "100%", objectFit: "contain" },
  badge: {
    position: "absolute",
    top: 16,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: colors.overlayScrim,
    color: "#fff",
    padding: "6px 14px",
    borderRadius: radius.sm,
    fontSize: font.sm,
    fontWeight: 700,
    whiteSpace: "nowrap",
    zIndex: 10,
  },
  confirm: {
    position: "absolute",
    bottom: 36,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,
  },
};

// 底部提示膠囊（可堆疊）。Viewfinder 依優先權決定要顯示哪些 items。
import DirectionArrow from "./DirectionArrow";
import { colors, radius, font } from "../../styles/theme";

export default function HintBanner({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={styles.stack}>
      {items.map((item, i) => (
        <div key={i} style={styles.pill}>
          {(item.arrow || typeof item.angle === "number") && (
            <DirectionArrow direction={item.arrow} angle={item.angle} />
          )}
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  );
}

const styles = {
  stack: {
    position: "absolute",
    bottom: 128,
    left: "50%",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8,
    zIndex: 25,
    pointerEvents: "none",
  },
  pill: {
    backgroundColor: colors.overlayScrim,
    color: "#fff",
    padding: "9px 18px",
    borderRadius: radius.pill,
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: font.md,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
};

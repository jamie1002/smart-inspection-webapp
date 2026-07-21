// 四方位進度指示（iRent 風格）
// 使用去背的實拍車輛四方位圖；三態：已完成（綠框+勾）/進行中（紅框高亮）/未拍（暗）。
import { POSITION_SEQUENCE, GUIDE_TEMPLATES } from "../../constants/guideTemplates";
import { colors, radius, font } from "../../styles/theme";

import rightFront from "../../assets/car-angles/right_front.png";
import frontLeft from "../../assets/car-angles/front_left.png";
import leftRear from "../../assets/car-angles/left_rear.png";
import rightRear from "../../assets/car-angles/right_rear.png";

const CAR_IMG = {
  front_left: frontLeft,
  left_rear: leftRear,
  right_rear: rightRear,
  right_front: rightFront,
};

export default function PositionCompass({ currentPosition, capturedByPosition, onSelectPosition }) {
  return (
    <div style={styles.wrap}>
      {POSITION_SEQUENCE.map((position) => {
        const done = !!capturedByPosition?.[position];
        const current = position === currentPosition;
        const state = done ? "done" : current ? "current" : "pending";
        const borderColor =
          state === "current" ? colors.brand : state === "done" ? colors.success : colors.border;
        return (
          <button
            key={position}
            type="button"
            onClick={() => onSelectPosition?.(position)}
            style={styles.item}
          >
            <div
              style={{
                ...styles.iconBox,
                borderColor,
                backgroundColor: state === "current" ? colors.brandSoft : "rgba(255,255,255,0.04)",
                boxShadow: state === "current" ? `0 0 10px ${colors.brand}66` : "none",
              }}
            >
              <img
                src={CAR_IMG[position]}
                alt={GUIDE_TEMPLATES[position].label}
                style={{
                  ...styles.carImg,
                  opacity: state === "pending" ? 0.4 : 1,
                  filter: state === "pending" ? "grayscale(1)" : "none",
                }}
              />
              {done && <span style={styles.check}>✓</span>}
            </div>
            <span
              style={{
                ...styles.label,
                color:
                  state === "current" ? "#fff" : state === "done" ? colors.success : colors.textMuted,
                fontWeight: state === "current" ? 700 : 500,
              }}
            >
              {GUIDE_TEMPLATES[position].label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const styles = {
  wrap: {
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 8,
    width: "100%",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    flex: "0 0 auto",
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    cursor: "pointer",
    pointerEvents: "auto",
  },
  iconBox: {
    position: "relative",
    width: 62,
    height: 40,
    borderRadius: radius.sm,
    border: "1.5px solid",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
    transition: "border-color 0.2s, box-shadow 0.2s",
  },
  carImg: {
    width: "88%",
    height: "auto",
    objectFit: "contain",
    display: "block",
  },
  check: {
    position: "absolute",
    top: 1,
    right: 3,
    color: colors.success,
    fontSize: font.sm,
    fontWeight: 700,
    textShadow: "0 0 3px rgba(0,0,0,0.8)",
  },
  label: {
    fontSize: font.xs,
  },
};

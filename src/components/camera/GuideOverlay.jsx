// 取景引導疊圖（依車款）
// 車身：GUIDE_CAR_STYLE='ghost' → 半透明實拍去背車（GHOST_OPACITY）＋白色外框線稿
//        GUIDE_CAR_STYLE='line'  → 只有白色外框線稿
// 車牌/車輪：線稿，對齊該類偵測時轉綠（detections[key].aligned）。
// 右側方位以水平鏡像自動生成。ghost 的車牌區域已擦成透明（避免露出他車車牌）。
// viewBox 720x1280（=9:16），與相機取景框同比例，preserveAspectRatio=none 精準對位。
import { CAR_MODELS } from "../../constants/carModels";
import { ASPECT_RATIOS } from "../../constants/aspectRatios";
import {
  GUIDE_CAR_STYLE,
  GHOST_OPACITY,
} from "../../constants/guideOutlines";
import { colors } from "../../styles/theme";

export default function GuideOverlay({ carModel, cropRatio, position, detections }) {
  const model = CAR_MODELS[carModel];
  const g = model?.variants?.[cropRatio]?.outlines?.[position];
  const viewBox = ASPECT_RATIOS[cropRatio]?.viewBox || ASPECT_RATIOS["9:16"].viewBox;
  if (!g) return null;

  const useGhost = GUIDE_CAR_STYLE === "ghost";
  const ghostSrc = position.includes("front") ? model.variants[cropRatio].ghost.front : model.variants[cropRatio].ghost.rear;
  const plateColor = detections?.license_plate?.aligned ? colors.success : "#ffffff";
  const wheelColor = detections?.wheel?.aligned ? colors.success : "#ffffff";
  const svgMirror = g.mirror ? `translate(${viewBox.w},0) scale(-1,1)` : undefined;

  return (
    <div style={styles.wrap}>
      {useGhost && (
        <img
          src={ghostSrc}
          alt=""
          style={{
            ...styles.ghost,
            opacity: GHOST_OPACITY,
            transform: g.mirror ? "scaleX(-1)" : "none",
          }}
        />
      )}
      <svg
        style={styles.svg}
        viewBox={`0 0 ${viewBox.w} ${viewBox.h}`}
        preserveAspectRatio="none"
      >
        <g transform={svgMirror}>
          {/* 車身外框線稿：兩種風格都畫（ghost 時疊在半透明車上更清楚） */}
          <path d={g.car} fill="none" stroke="#ffffff" strokeWidth="3" strokeOpacity="0.5" />
          <path
            d={g.plate}
            fill="none"
            stroke={plateColor}
            strokeWidth="4"
            strokeOpacity="0.9"
            strokeDasharray="8 5"
          />
          <path
            d={g.wheel}
            fill="none"
            stroke={wheelColor}
            strokeWidth="4"
            strokeOpacity="0.9"
            strokeDasharray="8 5"
          />
        </g>
      </svg>
    </div>
  );
}

const styles = {
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
  ghost: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  svg: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
  },
};

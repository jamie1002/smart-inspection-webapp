// 四方位縮圖元件（支援動態比例 3:4 / 9:16 與 AI 車損 SVG 重疊標註）
import { colors, radius, font } from "../../styles/theme";

const DAMAGE_LABEL_MAP = {
  scratch: "刮痕",
  dent: "凹痕",
  crack: "裂痕",
  dislocation: "移位",
  rust: "鏽蝕",
};

export default function DamageThumbnail({ photo, positionLabel, cropRatio = "9:16" }) {
  if (!photo) return null;

  const damages = photo?.damages || [];
  const imgW = photo?.image_width || photo?.imageWidth || photo?.meta?.imageWidth || 1920;
  const imgH = photo?.image_height || photo?.imageHeight || photo?.meta?.imageHeight || 1920;

  // 判斷比例：若傳入 cropRatio 為 3:4，或圖片本身寬高比接近 0.75，顯示為 3:4 比例
  const is34 = cropRatio === "3:4" || (imgW && imgH && (imgW / imgH > 0.7));
  const aspectRatioVal = is34 ? "3 / 4" : "9 / 16";

  return (
    <div style={{ ...styles.container, aspectRatio: aspectRatioVal }}>
      <img src={photo.dataUrl} alt={positionLabel} style={styles.img} />

      {/* 後端 AI 車損渲染重疊層 (SVG Overlay) */}
      {damages.length > 0 && (
        <svg style={styles.svgOverlay} viewBox="0 0 100 100" preserveAspectRatio="none">
          {damages.map((item, idx) => {
            let xMin = 0, xMax = 0, yMin = 0, yMax = 0;
            if (item.x1 !== undefined) {
              if (item.x1 > 1.0) {
                xMin = (item.x1 / imgW) * 100;
                xMax = (item.x2 / imgW) * 100;
                yMin = (item.y1 / imgH) * 100;
                yMax = (item.y2 / imgH) * 100;
              } else {
                xMin = item.x1 * 100;
                xMax = item.x2 * 100;
                yMin = item.y1 * 100;
                yMax = item.y2 * 100;
              }
            } else if (item.box_pct) {
              xMin = item.box_pct.xMin;
              xMax = item.box_pct.xMax;
              yMin = item.box_pct.yMin;
              yMax = item.box_pct.yMax;
            }

            const w = Math.max(1, xMax - xMin);
            const h = Math.max(1, yMax - yMin);

            const labelName = DAMAGE_LABEL_MAP[item.label] || item.label || "車損";
            const confPct = item.confidence ? Math.round(item.confidence * 100) : null;
            const labelText = confPct ? `${labelName} ${confPct}%` : labelName;

            return (
              <g key={idx}>
                <rect
                  x={xMin}
                  y={yMin}
                  width={w}
                  height={h}
                  fill="rgba(255, 77, 79, 0.3)"
                  stroke="#ff4d4f"
                  strokeWidth="1.5"
                  rx="1"
                />
                <rect
                  x={xMin}
                  y={Math.max(0, yMin - 5)}
                  width={Math.min(48, Math.max(18, labelText.length * 4.2))}
                  height="5"
                  fill="#ff4d4f"
                  rx="1"
                />
                <text
                  x={xMin + 1}
                  y={Math.max(3.8, yMin - 1.2)}
                  fill="#ffffff"
                  fontSize="3.5"
                  fontWeight="bold"
                >
                  {labelText}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* 車損數量標籤 Badge */}
      {damages.length > 0 && (
        <div style={styles.damageBadge}>
          {damages.length} 處車損
        </div>
      )}

      {/* 角度名稱標籤 */}
      <div style={styles.labelTag}>{positionLabel}</div>
    </div>
  );
}

const styles = {
  container: {
    position: "relative",
    width: "100%",
    borderRadius: radius.sm,
    overflow: "hidden",
    backgroundColor: "#000",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
  },
  img: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  svgOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: 2,
  },
  damageBadge: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "rgba(255, 77, 79, 0.95)",
    color: "#fff",
    padding: "2px 6px",
    borderRadius: 4,
    fontSize: "10px",
    fontWeight: 700,
    zIndex: 3,
    boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
  },
  labelTag: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    color: "#fff",
    fontSize: font.xs,
    textAlign: "center",
    padding: "3px 0",
    fontWeight: 600,
    zIndex: 3,
  },
};

// 逐張車損比對（REVIEWING）：動態計算照片實際渲染框 (包含 Letterbox 留白扣除)
import { useState, useRef, useEffect, useCallback } from "react";
import { colors, font, radius, primaryButton } from "../../styles/theme";

const DAMAGE_LABEL_MAP = {
  scratch: "刮痕",
  dent: "凹痕",
  crack: "裂痕",
  dislocation: "移位",
  rust: "鏽蝕",
};

export default function ReviewScreen({ reviewPhoto, positionLabel, reviewIndex, total, onConfirm }) {
  const containerRef = useRef(null);
  const [imgRect, setImgRect] = useState(null);

  const damages = reviewPhoto?.damages || [];
  const imgW = reviewPhoto?.image_width || reviewPhoto?.imageWidth || reviewPhoto?.meta?.imageWidth || 1920;
  const imgH = reviewPhoto?.image_height || reviewPhoto?.imageHeight || reviewPhoto?.meta?.imageHeight || 1920;

  // 計算物件 Contain 縮放後真正的照片顯示區域 (避開上下/左右黑邊)
  const updateImgRect = useCallback(() => {
    if (!containerRef.current) return;
    const cw = containerRef.current.clientWidth;
    const ch = containerRef.current.clientHeight;
    if (!cw || !ch || !imgW || !imgH) return;

    const containerRatio = cw / ch;
    const imgRatio = imgW / imgH;

    let w, h, top, left;
    if (imgRatio < containerRatio) {
      // 兩側留白 (Pillarbox)
      h = ch;
      w = ch * imgRatio;
      top = 0;
      left = (cw - w) / 2;
    } else {
      // 上下留白 (Letterbox)
      w = cw;
      h = cw / imgRatio;
      left = 0;
      top = (ch - h) / 2;
    }

    setImgRect({ left, top, width: w, height: h });
  }, [imgW, imgH]);

  useEffect(() => {
    updateImgRect();
    window.addEventListener("resize", updateImgRect);
    return () => window.removeEventListener("resize", updateImgRect);
  }, [updateImgRect]);

  return (
    <div style={styles.container}>
      <div ref={containerRef} style={styles.imgWrap}>
        <img
          src={reviewPhoto.dataUrl}
          alt="車損標記比對"
          style={styles.img}
          onLoad={updateImgRect}
        />

        {/* 後端 AI 車損渲染重疊層 (與照片真實顯示區域 100% 重疊，排除上下/左右黑邊) */}
        {damages.length > 0 && imgRect && (
          <svg
            style={{
              position: "absolute",
              left: `${imgRect.left}px`,
              top: `${imgRect.top}px`,
              width: `${imgRect.width}px`,
              height: `${imgRect.height}px`,
              pointerEvents: "none",
              zIndex: 5,
            }}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
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

              const w = Math.max(0.5, xMax - xMin);
              const h = Math.max(0.5, yMax - yMin);

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
                    fill="rgba(255, 77, 79, 0.25)"
                    stroke="#ff4d4f"
                    strokeWidth="0.8"
                    rx="0.5"
                  />
                  <rect
                    x={xMin}
                    y={Math.max(0, yMin - 3.5)}
                    width={Math.min(30, Math.max(12, labelText.length * 2.8))}
                    height="3.2"
                    fill="#ff4d4f"
                    rx="0.5"
                  />
                  <text
                    x={xMin + 0.8}
                    y={Math.max(2.2, yMin - 1.2)}
                    fill="#ffffff"
                    fontSize="2.2"
                    fontWeight="bold"
                  >
                    {labelText}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div style={styles.badge}>{positionLabel}（第 {reviewIndex + 1} / {total} 張）</div>
      {damages.length > 0 && (
        <div style={styles.damageBadge}>偵測到 {damages.length} 處車損標記</div>
      )}
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
  imgWrap: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
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
  damageBadge: {
    position: "absolute",
    top: 54,
    left: "50%",
    transform: "translateX(-50%)",
    backgroundColor: "rgba(255, 77, 79, 0.9)",
    color: "#fff",
    padding: "4px 12px",
    borderRadius: radius.sm,
    fontSize: font.xs,
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

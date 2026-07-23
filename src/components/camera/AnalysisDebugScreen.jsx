// 後端 AI 車損回傳驗證畫面 (ANALYSIS_DEBUG)
import { colors, font, space, radius, primaryButton } from "../../styles/theme";
import { GUIDE_TEMPLATES, POSITION_SEQUENCE } from "../../constants/guideTemplates";

const DAMAGE_LABEL_MAP = {
  scratch: "刮痕 (scratch)",
  dent: "凹痕 (dent)",
  crack: "裂痕 (crack)",
  dislocation: "移位 (dislocation)",
  rust: "鏽蝕 (rust)",
};

export default function AnalysisDebugScreen({ capturedByPosition, onNext }) {
  let totalDamages = 0;
  POSITION_SEQUENCE.forEach((pos) => {
    totalDamages += capturedByPosition[pos]?.damages?.length || 0;
  });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.tag}>實時監聽驗證</div>
        <h2 style={styles.title}>AI 回傳車損座標驗證頁面</h2>
        <p style={styles.subtitle}>
          已成功自 Firebase 抓取資料！目前共接收到 <span style={styles.highlight}>{totalDamages}</span> 處車損標記
        </p>
      </div>

      <div style={styles.cardList}>
        {POSITION_SEQUENCE.map((pos) => {
          const item = capturedByPosition[pos];
          const label = GUIDE_TEMPLATES[pos]?.label || pos;
          const damages = Array.isArray(item?.damages) ? item.damages : [];
          const imgW = item?.image_width || item?.imageWidth || item?.meta?.imageWidth || 1920;
          const imgH = item?.image_height || item?.imageHeight || item?.meta?.imageHeight || 1920;

          return (
            <div key={pos} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.posName}>{label} ({pos})</span>
                <span style={damages.length > 0 ? styles.damageCount : styles.zeroCount}>
                  {damages.length > 0 ? `收到 ${damages.length} 筆車損` : "無車損 (0筆 / null)"}
                </span>
              </div>

              {damages.length === 0 ? (
                <div style={styles.emptyText}>後端未傳回或標記此角度無車損 (damages: {item?.damages === null ? "null" : "[]"})</div>
              ) : (
                damages.map((d, idx) => {
                  const labelText = DAMAGE_LABEL_MAP[d.label] || d.label;
                  const conf = d.confidence ? (d.confidence * 100).toFixed(1) + "%" : "N/A";

                  // 計算像素與比例換算值
                  const isPixel = d.x1 > 1.0;
                  const px1 = isPixel ? d.x1 : Math.round(d.x1 * imgW);
                  const px2 = isPixel ? d.x2 : Math.round(d.x2 * imgW);
                  const py1 = isPixel ? d.y1 : Math.round(d.y1 * imgH);
                  const py2 = isPixel ? d.y2 : Math.round(d.y2 * imgH);

                  const pctX1 = (px1 / imgW * 100).toFixed(2);
                  const pctX2 = (px2 / imgW * 100).toFixed(2);
                  const pctY1 = (py1 / imgH * 100).toFixed(2);
                  const pctY2 = (py2 / imgH * 100).toFixed(2);

                  return (
                    <div key={idx} style={styles.damageBox}>
                      <div style={styles.damageTitle}>
                        #{idx + 1} {labelText} ── 置信度: {conf}
                      </div>
                      <div style={styles.codeBlock}>
                        <div><strong style={{ color: "#ffd666" }}>[Firebase 原始值]</strong> x1: {d.x1}, x2: {d.x2}, y1: {d.y1}, y2: {d.y2}</div>
                        <div><strong style={{ color: "#69c0ff" }}>[像素座標值]</strong> X: {px1}px ~ {px2}px | Y: {py1}px ~ {py2}px</div>
                        <div><strong style={{ color: "#95de64" }}>[畫面比例換算]</strong> X: {pctX1}% ~ {pctX2}% | Y: {pctY1}% ~ {pctY2}%</div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>

      <div style={styles.footer}>
        <button style={{ ...primaryButton, ...styles.btn }} onClick={onNext}>
          確認無誤，進入四方位車損畫框比對 ➔
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    width: "100%",
    height: "100%",
    backgroundColor: colors.bg,
    display: "flex",
    flexDirection: "column",
    padding: space.md,
    boxSizing: "border-box",
    overflowY: "auto",
  },
  header: {
    textAlign: "center",
    marginBottom: space.md,
  },
  tag: {
    display: "inline-block",
    backgroundColor: "rgba(24, 144, 255, 0.2)",
    color: "#1890ff",
    border: "1px solid #1890ff",
    borderRadius: radius.sm,
    padding: "2px 8px",
    fontSize: font.xs,
    fontWeight: 700,
    marginBottom: 6,
  },
  title: {
    color: "#ffffff",
    fontSize: font.lg,
    margin: "4px 0",
    fontWeight: 700,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: font.sm,
    margin: 0,
  },
  highlight: {
    color: "#ff4d4f",
    fontWeight: 700,
    fontSize: font.md,
  },
  cardList: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    overflowY: "auto",
    paddingRight: 4,
  },
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    border: `1px solid ${colors.border}`,
    borderRadius: radius.md,
    padding: space.md,
  },
  cardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: space.xs,
  },
  posName: {
    color: "#ffffff",
    fontSize: font.md,
    fontWeight: 700,
  },
  damageCount: {
    backgroundColor: "#ff4d4f",
    color: "#ffffff",
    padding: "2px 8px",
    borderRadius: radius.sm,
    fontSize: font.xs,
    fontWeight: 700,
  },
  zeroCount: {
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    color: colors.textSecondary,
    padding: "2px 8px",
    borderRadius: radius.sm,
    fontSize: font.xs,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: font.xs,
    fontStyle: "italic",
    marginTop: space.xs,
  },
  damageBox: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: radius.sm,
    padding: space.xs + 2,
    marginTop: space.xs,
    borderLeft: "3px solid #ff4d4f",
  },
  damageTitle: {
    color: "#ffffff",
    fontSize: font.xs,
    fontWeight: 700,
    marginBottom: 4,
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: "11px",
    color: "#e6f7ff",
    lineHeight: 1.5,
  },
  footer: {
    marginTop: space.md,
    display: "flex",
    justifyContent: "center",
  },
  btn: {
    width: "100%",
    maxWidth: 360,
  },
};

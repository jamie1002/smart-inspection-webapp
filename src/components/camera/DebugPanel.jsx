// 除錯數值面板（Raw 尺寸、各偵測 conf、對齊狀態、模糊分數）
// ⚠️ 測試版限定：僅在 IS_TEST_MODE 為真時由 Viewfinder 掛載，正式版不渲染。
import { colors, font } from "../../styles/theme";

export default function DebugPanel({ rawW, rawH, detections, blurScore }) {
  return (
    <div style={styles.panel}>
      <div>Raw: {rawW || "?"}×{rawH || "?"}</div>
      {typeof blurScore === "number" && <div>blur: {blurScore.toFixed(1)}</div>}
      {Object.entries(detections).map(([key, det]) => (
        <div key={key}>
          {key}: conf={det.conf.toFixed(2)} {det.aligned ? "✅" : "❌"}
        </div>
      ))}
    </div>
  );
}

const styles = {
  panel: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: colors.overlayScrim,
    color: "#fff",
    padding: "6px 10px",
    borderRadius: 6,
    fontSize: font.sm,
    lineHeight: 1.5,
    zIndex: 10,
    fontFamily: "monospace",
    textAlign: "left",
  },
};

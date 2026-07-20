// 取景畫面（SHOOTING）：四方位進度 + video + 引導框 + 偵測框(測試) + 提示 + 快門
import GuideOverlay from "./GuideOverlay";
import DetectionOverlay from "./DetectionOverlay";
import DebugPanel from "./DebugPanel";
import HintBanner from "./HintBanner";
import PositionCompass from "./PositionCompass";
import AutoCaptureRing from "./AutoCaptureRing";
import { IS_TEST_MODE } from "../../config/appConfig";
import { CAPTURE_STABLE_DURATION_MS } from "../../constants/detection";
import { colors, font, z } from "../../styles/theme";

export default function Viewfinder({
  videoRef,
  template,
  positionIndex,
  completedCount,
  modelReady,
  modelError,
  detections,
  isFlipped,
  orientationOk,
  orientationIssues,
  liveBlurOk,
  needsDetection,
  distanceHint,
  horizontalHint,
  verticalHint,
  stableCountdownActive,
  ready,
  rawW,
  rawH,
  blurScore,
  onManualCapture,
}) {
  // 依優先權決定底部提示膠囊（各分支互斥）
  const clear = !isFlipped && orientationOk && liveBlurOk;
  const showBlur = !isFlipped && orientationOk && !liveBlurOk;
  const showNeedsDetection = clear && needsDetection;

  const moveItems = [];
  if (clear && !needsDetection) {
    if (distanceHint || horizontalHint) {
      if (distanceHint) moveItems.push(distanceHint);
      if (horizontalHint) moveItems.push(horizontalHint);
    } else if (verticalHint) {
      moveItems.push(verticalHint);
    }
  }

  const showStable =
    clear && !needsDetection && !distanceHint && !horizontalHint && !verticalHint && stableCountdownActive;

  return (
    <div style={styles.container}>
      <div style={styles.compassBar}>
        <PositionCompass currentIndex={positionIndex} completedCount={completedCount} />
      </div>

      <div style={styles.viewfinder}>
        <video ref={videoRef} autoPlay playsInline muted style={styles.video} />

        <GuideOverlay template={template} />
        {IS_TEST_MODE && <DetectionOverlay detections={detections} />}

        {!modelReady && !modelError && <div style={styles.modelBadge}>模型載入中…</div>}
        {modelError && <div style={styles.modelBadge}>模型載入失敗</div>}

        {/* 方位反轉警告（半透明遮罩，不全黑，保留方位提示） */}
        {isFlipped && (
          <div style={styles.warning}>
            <p style={styles.warningTitle}>請重新確認方位</p>
            <p style={styles.warningSub}>目前應拍攝：{template?.label}</p>
          </div>
        )}

        {/* 方向鎖警告 */}
        {!isFlipped && !orientationOk && (
          <div style={styles.warning}>
            {orientationIssues.betaBad && <p style={styles.warningTitle}>請直立鏡頭</p>}
            {orientationIssues.gammaBad && <p style={styles.warningTitle}>請保持畫面水平</p>}
            <p style={styles.warningSub}>目前應拍攝：{template?.label}</p>
          </div>
        )}

        {showBlur && <HintBanner items={[{ text: "畫面模糊" }]} />}
        {showNeedsDetection && <HintBanner items={[{ text: "請將車牌與輪胎都置於畫面內" }]} />}
        {moveItems.length > 0 && <HintBanner items={moveItems} />}
        {showStable && <HintBanner items={[{ text: "請保持不動" }]} />}

        {IS_TEST_MODE && (
          <DebugPanel rawW={rawW} rawH={rawH} detections={detections} blurScore={blurScore} />
        )}

        {/* 底部：測試版可手動快門；正式版僅自動拍照狀態環 */}
        {IS_TEST_MODE ? (
          <button style={styles.shutter} onClick={onManualCapture} aria-label="手動拍照">
            <div style={styles.shutterInner} />
          </button>
        ) : (
          <AutoCaptureRing
            ready={ready}
            counting={stableCountdownActive}
            durationMs={CAPTURE_STABLE_DURATION_MS}
          />
        )}
      </div>
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
  },
  compassBar: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    padding: "10px 8px",
    display: "flex",
    justifyContent: "center",
    zIndex: z.compass,
    background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 100%)",
    boxSizing: "border-box",
    pointerEvents: "none",
  },
  viewfinder: {
    position: "relative",
    width: "100%",
    maxWidth: "calc(100vh * (9 / 16))",
    aspectRatio: "9 / 16",
    backgroundColor: "#111",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    touchAction: "none",
  },
  video: { width: "100%", height: "100%", objectFit: "cover" },
  modelBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    backgroundColor: colors.overlayScrim,
    color: "#fff",
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: font.xs,
    zIndex: 10,
  },
  warning: {
    position: "absolute",
    inset: 0,
    backgroundColor: colors.overlayScrim,
    color: "#fff",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    textAlign: "center",
    padding: 24,
    gap: 8,
    zIndex: z.warning,
  },
  warningTitle: { fontSize: font.xl, fontWeight: 800 },
  warningSub: { fontSize: font.md, fontWeight: 500, color: colors.success },
  shutter: {
    position: "absolute",
    bottom: 32,
    left: "50%",
    transform: "translateX(-50%)",
    width: 72,
    height: 72,
    borderRadius: "50%",
    backgroundColor: "rgba(255,255,255,0.4)",
    border: "4px solid #fff",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    cursor: "pointer",
    padding: 0,
    zIndex: z.shutter,
  },
  shutterInner: { width: 54, height: 54, borderRadius: "50%", backgroundColor: "#fff" },
};

import { useState, useRef, useEffect, useCallback } from "react";

// ============================================
// 設定檔區塊：內層引導方格的百分比座標（佔位用範例值）
// 之後有黃金標準照實測數據後，直接替換這個物件即可，
// 不需要更動下方任何邏輯程式碼。
// ============================================
const GUIDE_TEMPLATES = {
  front_left: {
    label: "左前",
    licensePlate: { xMin: 7.4, xMax: 18.7, yMin: 53.7, yMax: 60.6 },
    wheel: { xMin: 63.3, xMax: 77.9, yMin: 49.6, yMax: 64.4 },
  },
  // 其餘三個方位（front_right / rear_left / rear_right）
  // 待取得黃金標準照實測數據後再補上
};

// 相機權限與初始化的狀態機
const CAMERA_STATUS = {
  IDLE: "idle", // 尚未點擊授權按鈕
  REQUESTING: "requesting", // 授權請求中
  GRANTED: "granted", // 授權成功，串流運作中
  DENIED: "denied", // 使用者拒絕授權
  UNSUPPORTED: "unsupported", // 裝置不支援相關 API
  ERROR: "error", // 其他未預期錯誤
};

export default function CameraModule() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  const [status, setStatus] = useState(CAMERA_STATUS.IDLE);
  const [aspectRatio, setAspectRatio] = useState(16 / 9); // 預設值，實際會被 getSettings() 覆蓋
  const [currentPosition] = useState("front_left"); // 之後由模組 E 換位邏輯控制

  // 清除相機串流的共用函式，確保鏡頭燈確實關閉
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const requestCamera = useCallback(async () => {
    // 裝置基本能力檢查
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(CAMERA_STATUS.UNSUPPORTED);
      return;
    }

    setStatus(CAMERA_STATUS.REQUESTING);

    const constraints = {
      video: {
        facingMode: { ideal: "environment" },
        aspectRatio: { ideal: 0.5625 }, // 9:16 直式，用 ideal 而非 exact 避免 OverconstrainedError
      },
      audio: false,
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      // 務必檢查實際取得的比例，後續座標換算需依此動態計算，不可寫死假設
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();

      if (settings.aspectRatio) {
        setAspectRatio(settings.aspectRatio);
      } else if (settings.width && settings.height) {
        // 部分裝置不回傳 aspectRatio，改用 width/height 計算
        setAspectRatio(settings.width / settings.height);
      }

      // 注意：這裡不再直接操作 videoRef.current.srcObject，
      // 因為此時 <video> 元素尚未被渲染出來（status 還沒變成 GRANTED），
      // videoRef.current 仍是 null。改由下方的 useEffect 負責賦值。
      setStatus(CAMERA_STATUS.GRANTED);
    } catch (err) {
      // NotAllowedError：使用者主動拒絕授權
      // NotFoundError：裝置沒有相機硬體
      // OverconstrainedError：理論上用 ideal 後不該再發生，仍保留判斷
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setStatus(CAMERA_STATUS.DENIED);
      } else {
        setStatus(CAMERA_STATUS.ERROR);
      }
      console.error("相機授權失敗：", err);
    }
  }, []);

  // 新增：當 status 變成 GRANTED、<video> 元素真正掛載到畫面後，
  // 才把已經取得的串流接上去，避免 videoRef.current 為 null 的時機問題
  useEffect(() => {
    if (status === CAMERA_STATUS.GRANTED && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [status]);

  // 元件卸載時，務必關閉相機串流，避免鏡頭燈持續亮著
  useEffect(() => {
    return () => {
      stopStream();
    };
  }, [stopStream]);

  const template = GUIDE_TEMPLATES[currentPosition];

  return (
    <div style={styles.pageWrapper}>
      {/* ===== 尚未授權：顯示入口按鈕 ===== */}
      {status === CAMERA_STATUS.IDLE && (
        <div style={styles.centerScreen}>
          <button style={styles.startButton} onClick={requestCamera}>
            開始檢測車況
          </button>
        </div>
      )}

      {/* ===== 授權請求中 ===== */}
      {status === CAMERA_STATUS.REQUESTING && (
        <div style={styles.centerScreen}>
          <p>正在請求相機權限，請於瀏覽器彈出視窗中允許存取...</p>
        </div>
      )}

      {/* ===== 使用者拒絕授權 ===== */}
      {status === CAMERA_STATUS.DENIED && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>需要相機權限才能進行檢測</p>
          <p>請至瀏覽器設定重新開啟本網站的相機權限後再試一次。</p>
          <button style={styles.startButton} onClick={requestCamera}>
            重新授權
          </button>
        </div>
      )}

      {/* ===== 裝置不支援 ===== */}
      {status === CAMERA_STATUS.UNSUPPORTED && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>此裝置或瀏覽器不支援相機功能</p>
          <p>請改用支援 HTTPS 環境下相機存取的行動裝置瀏覽器。</p>
        </div>
      )}

      {/* ===== 其他錯誤 ===== */}
      {status === CAMERA_STATUS.ERROR && (
        <div style={styles.centerScreen}>
          <p style={styles.errorText}>相機初始化發生未預期錯誤</p>
          <button style={styles.startButton} onClick={requestCamera}>
            重試
          </button>
        </div>
      )}

      {/* ===== 授權成功：顯示相機畫面與引導方格 ===== */}
      {status === CAMERA_STATUS.GRANTED && (
        <div
          style={{
            ...styles.cameraContainer,
            aspectRatio: aspectRatio,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={styles.video}
          />

          {/* 內層引導方格：以容器百分比座標定位，獨立於外層比例 */}
          {template && (
            <svg style={styles.guideOverlay} preserveAspectRatio="none">
              {/* 車牌引導框 */}
              <rect
                x={`${template.licensePlate.xMin}%`}
                y={`${template.licensePlate.yMin}%`}
                width={`${template.licensePlate.xMax - template.licensePlate.xMin}%`}
                height={`${template.licensePlate.yMax - template.licensePlate.yMin}%`}
                fill="none"
                stroke="#00ff88"
                strokeWidth="2"
                strokeOpacity="0.8"
              />
              {/* 車輪引導框 */}
              <rect
                x={`${template.wheel.xMin}%`}
                y={`${template.wheel.yMin}%`}
                width={`${template.wheel.xMax - template.wheel.xMin}%`}
                height={`${template.wheel.yMax - template.wheel.yMin}%`}
                fill="none"
                stroke="#00ff88"
                strokeWidth="2"
                strokeOpacity="0.8"
              />
            </svg>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// 樣式（先用 inline style 快速驗證邏輯，
// 之後可依團隊習慣改為 CSS Module 或 Tailwind）
// ============================================
const styles = {
  pageWrapper: {
    width: "100vw",
    height: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
  },
  centerScreen: {
    color: "#fff",
    textAlign: "center",
    padding: "24px",
  },
  errorText: {
    color: "#ff4d4f",
    fontWeight: "bold",
    fontSize: "18px",
  },
  startButton: {
    padding: "16px 32px",
    fontSize: "18px",
    borderRadius: "8px",
    border: "none",
    backgroundColor: "#00ff88",
    color: "#000",
    fontWeight: "bold",
    cursor: "pointer",
  },
  cameraContainer: {
    position: "relative",
    width: "100%",
    maxHeight: "100vh",
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  guideOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
  },
};
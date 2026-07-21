// 開始檢測前畫面：人員 / 車牌 輸入（卡片式，iRent 風格）
// 同時處理 requesting / denied / unsupported / error 狀態訊息。
import { CAMERA_STATUS } from "../../constants/flow";
import { CAR_MODEL_LIST } from "../../constants/carModels";
import { colors, space, radius, font, primaryButton, disabledButton } from "../../styles/theme";

export default function StartScreen({
  status,
  carModel,
  onCarModelChange,
  personnelName,
  plateNumberInput,
  onPersonnelChange,
  onPlateChange,
  canStart,
  onStart,
}) {
  if (status === CAMERA_STATUS.REQUESTING) {
    return <Center><p style={styles.msg}>正在請求相機權限…</p></Center>;
  }
  if (status === CAMERA_STATUS.UNSUPPORTED) {
    return <Center><p style={styles.err}>此裝置或瀏覽器不支援相機功能</p></Center>;
  }
  if (status === CAMERA_STATUS.DENIED) {
    return (
      <Center>
        <p style={styles.err}>需要相機權限才能進行檢測</p>
        <p style={styles.hint}>
          若按下重試沒有反應，代表瀏覽器已記住您的拒絕設定，請至瀏覽器的網站設定允許相機權限後，重新整理頁面。
        </p>
        <button style={primaryButton} onClick={onStart}>重新嘗試</button>
      </Center>
    );
  }
  if (status === CAMERA_STATUS.ERROR) {
    return (
      <Center>
        <p style={styles.err}>初始化發生錯誤</p>
        <button style={primaryButton} onClick={onStart}>重新嘗試</button>
      </Center>
    );
  }

  // IDLE
  return (
    <Center>
      <div style={styles.brandRow}>
        <span style={styles.brandDot} />
        <span style={styles.brandText}>智能檢車</span>
      </div>
      <p style={styles.subtitle}>四方位引導式自動拍照</p>

      <div style={styles.card}>
        <div style={styles.field}>
          <label style={styles.label}>車款</label>
          <select value={carModel} onChange={onCarModelChange} style={styles.input}>
            {CAR_MODEL_LIST.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
        <div style={styles.field}>
          <label style={styles.label}>人員</label>
          <input
            type="text"
            value={personnelName}
            onChange={onPersonnelChange}
            placeholder="請輸入人員姓名"
            style={styles.input}
          />
        </div>
        <div style={styles.field}>
          <label style={styles.label}>車牌</label>
          <input
            type="text"
            value={plateNumberInput}
            onChange={onPlateChange}
            placeholder="例如 ABC-1234"
            style={styles.input}
            autoCapitalize="characters"
          />
        </div>
      </div>

      <button
        style={{ ...primaryButton, ...styles.startBtn, ...(canStart ? {} : disabledButton) }}
        onClick={onStart}
        disabled={!canStart}
      >
        開始檢測
      </button>
      {!canStart && <p style={styles.hint}>請先填寫人員與車牌後再開始檢測</p>}
    </Center>
  );
}

function Center({ children }) {
  return <div style={styles.center}>{children}</div>;
}

const styles = {
  center: {
    width: "100%",
    maxWidth: 360,
    minHeight: "100%",
    margin: "0 auto",
    color: "#fff",
    textAlign: "center",
    padding: space.lg,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    boxSizing: "border-box",
  },
  brandRow: { display: "flex", alignItems: "center", gap: space.sm },
  brandDot: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    backgroundColor: colors.brand,
    display: "inline-block",
  },
  brandText: { fontSize: font.xxl, fontWeight: 800, letterSpacing: 1 },
  subtitle: { color: colors.textSecondary, fontSize: font.md, marginTop: -8 },
  card: {
    width: "100%",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.md,
    boxSizing: "border-box",
  },
  field: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 },
  label: { fontSize: font.sm, color: colors.textSecondary },
  input: {
    width: "100%",
    padding: "12px 14px",
    fontSize: font.lg,
    borderRadius: radius.sm,
    border: `1px solid ${colors.border}`,
    backgroundColor: colors.bg,
    color: "#fff",
    boxSizing: "border-box",
    outline: "none",
  },
  startBtn: { width: "100%", marginTop: space.xs },
  hint: { color: colors.textSecondary, fontSize: font.sm, lineHeight: 1.6, maxWidth: 320 },
  msg: { color: "#fff", fontSize: font.lg },
  err: { color: colors.danger, fontSize: font.lg, fontWeight: 700 },
};

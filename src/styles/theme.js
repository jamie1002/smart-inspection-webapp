// Design tokens（選項一：集中色票/間距/圓角，各元件 style 物件引用）
// iRent 風格近似色（非官方精確值，見規格 §5.1）

export const colors = {
  brand: "#E2231A",        // iRent 紅（近似）
  brandDark: "#B71C15",
  brandSoft: "rgba(226, 35, 26, 0.12)",

  bg: "#0E0E10",           // 深底（相機/深色頁）
  surface: "#1A1A1D",      // 卡片
  surfaceAlt: "#232327",
  border: "#33343A",

  textPrimary: "#FFFFFF",
  textSecondary: "#9AA0A6",
  textMuted: "#6B7075",

  success: "#00C36E",
  successSoft: "rgba(0, 195, 110, 0.15)",
  warning: "#FFB020",
  danger: "#FF4D4F",

  overlayScrim: "rgba(0, 0, 0, 0.75)",
  detectAligned: "#00ff66",
  detectMisaligned: "#ff9900",
  guideStroke: "#ffffff",
};

export const space = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

export const font = {
  xs: 12,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 22,
};

export const shadow = {
  card: "0 8px 24px rgba(0, 0, 0, 0.35)",
  pill: "0 4px 12px rgba(0, 0, 0, 0.3)",
};

export const z = {
  guide: 5,
  badge: 10,
  hint: 25,
  shutter: 30,
  warning: 40,
  compass: 50,
  preview: 100, // PreviewScreen 蓋在持續掛載的 Viewfinder(video) 之上
};

// 共用按鈕樣式產生器
export const buttonBase = {
  border: "none",
  borderRadius: radius.pill,
  fontWeight: 700,
  cursor: "pointer",
  transition: "transform 0.05s ease, opacity 0.15s ease",
};

export const primaryButton = {
  ...buttonBase,
  padding: "15px 32px",
  fontSize: font.lg,
  backgroundColor: colors.brand,
  color: "#fff",
};

export const secondaryButton = {
  ...buttonBase,
  padding: "15px 28px",
  fontSize: font.md,
  backgroundColor: "transparent",
  color: "#fff",
  border: `2px solid ${colors.border}`,
};

export const disabledButton = {
  backgroundColor: colors.surfaceAlt,
  color: colors.textMuted,
  cursor: "not-allowed",
};

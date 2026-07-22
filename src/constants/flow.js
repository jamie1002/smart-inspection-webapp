// 流程狀態機與相機狀態列舉
// 從 CameraModule.jsx 抽出，行為不變

export const FLOW_STAGE = {
  SHOOTING: "shooting",
  PREVIEW: "preview",
  ANALYZING: "analyzing",
  ANALYSIS_DEBUG: "analysis_debug",
  REVIEW_INTRO: "review_intro",
  REVIEWING: "reviewing",
  DOWNLOAD_PROMPT: "download_prompt",
  MANUAL_SAVE: "manual_save",
  COMPLETE: "complete",
};

export const CAMERA_STATUS = {
  IDLE: "idle",
  REQUESTING: "requesting",
  GRANTED: "granted",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
  ERROR: "error",
};

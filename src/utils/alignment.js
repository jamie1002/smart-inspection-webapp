// 對齊判斷與位置/距離提示純函式
// 從 CameraModule.jsx 抽出，判斷邏輯與優先權一律不變。
// 優先權：方位反轉 > 距離（前後）+ 左右（中心點優先，其次寬度） > 上下置中

import {
  POSITION_TOLERANCE_PERCENT,
  AREA_TOLERANCE_RATIO,
  HORIZONTAL_HINT_SIGN,
  VERTICAL_HINT_SIGN,
  CLASS_NAMES,
} from "../constants/detection";
import { GUIDE_TEMPLATES, keyToTemplateField } from "../constants/guideTemplates";

// templates 參數可傳入所選車款的目標框；未傳時退回預設 GUIDE_TEMPLATES（Altis）
export function evaluateAlignment(rawResults, position, templates = GUIDE_TEMPLATES) {
  const template = templates[position];
  const evaluated = {};

  for (const key of Object.keys(rawResults)) {
    const det = rawResults[key];
    const target = template[keyToTemplateField(key)];
    if (!target) {
      evaluated[key] = { ...det, aligned: false };
      continue;
    }

    const detCenterX = (det.xMinPct + det.xMaxPct) / 2;
    const detCenterY = (det.yMinPct + det.yMaxPct) / 2;
    const targetCenterX = (target.xMin + target.xMax) / 2;
    const targetCenterY = (target.yMin + target.yMax) / 2;

    const positionOk =
      Math.abs(detCenterX - targetCenterX) <= POSITION_TOLERANCE_PERCENT &&
      Math.abs(detCenterY - targetCenterY) <= POSITION_TOLERANCE_PERCENT;

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;

    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    evaluated[key] = { ...det, aligned: positionOk && areaOk };
  }

  return evaluated;
}

export function evaluatePositionAndDistance(rawResults, position, templates = GUIDE_TEMPLATES) {
  const template = templates[position];
  if (!template) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: false, incomplete: false };
  }

  const candidates = [];

  for (const key of Object.keys(rawResults)) {
    const det = rawResults[key];
    const target = template[keyToTemplateField(key)];
    if (!target) continue;

    const detCenterX = (det.xMinPct + det.xMaxPct) / 2;
    const detCenterY = (det.yMinPct + det.yMaxPct) / 2;
    const targetCenterX = (target.xMin + target.xMax) / 2;
    const targetCenterY = (target.yMin + target.yMax) / 2;

    const dx = detCenterX - targetCenterX;
    const dy = detCenterY - targetCenterY;

    const detWidthPct = det.xMaxPct - det.xMinPct;
    const targetWidthPct = target.xMax - target.xMin;
    const widthRatio = targetWidthPct > 0 ? detWidthPct / targetWidthPct : 0;

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;
    const areaError = Math.abs(areaRatio - 1);
    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    candidates.push({ key, dx, dy, centerX: detCenterX, widthRatio, areaRatio, areaError, areaOk });
  }

  if (candidates.length < CLASS_NAMES.length) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: false, incomplete: true };
  }

  // 方位反轉判斷（最高優先權）
  const plateCandidate = candidates.find((c) => c.key === "license_plate");
  const wheelCandidate = candidates.find((c) => c.key === "wheel");
  const plateTargetCenterX = (template.licensePlate.xMin + template.licensePlate.xMax) / 2;
  const wheelTargetCenterX = (template.wheel.xMin + template.wheel.xMax) / 2;
  const expectedPlateLeftOfWheel = plateTargetCenterX < wheelTargetCenterX;
  const actualPlateLeftOfWheel = plateCandidate.centerX < wheelCandidate.centerX;
  const isFlipped = expectedPlateLeftOfWheel !== actualPlateLeftOfWheel;

  if (isFlipped) {
    return { distanceHint: null, horizontalHint: null, verticalHint: null, isFlipped: true, incomplete: false };
  }

  // 距離提示（前後，面積比例）
  let distanceHint = null;
  const misalignedByArea = candidates.filter((c) => !c.areaOk);
  if (misalignedByArea.length > 0) {
    const worst = misalignedByArea.reduce((a, b) => (b.areaError > a.areaError ? b : a));
    const tooFar = worst.areaRatio < 1;
    distanceHint = {
      text: tooFar ? "請靠近一點" : "請往後退一點",
      arrow: tooFar ? "near" : "far",
      key: worst.key,
    };
  }

  // 左右提示：第一層中心點置中，其次寬度
  let horizontalHint = null;
  const misalignedByCenterX = candidates.filter((c) => Math.abs(c.dx) > POSITION_TOLERANCE_PERCENT);

  if (misalignedByCenterX.length > 0) {
    const worst = misalignedByCenterX.reduce((a, b) =>
      Math.abs(b.dx) > Math.abs(a.dx) ? b : a
    );
    const dxAdj = worst.dx * HORIZONTAL_HINT_SIGN;
    horizontalHint = {
      text: dxAdj > 0 ? "請往左移動" : "請往右移動",
      arrow: dxAdj > 0 ? "left" : "right",
      key: worst.key,
    };
  } else {
    const leftCandidate = expectedPlateLeftOfWheel ? plateCandidate : wheelCandidate;
    const rightCandidate = expectedPlateLeftOfWheel ? wheelCandidate : plateCandidate;
    const leftOverWidth = leftCandidate.widthRatio - (1 + AREA_TOLERANCE_RATIO);
    const rightOverWidth = rightCandidate.widthRatio - (1 + AREA_TOLERANCE_RATIO);

    if (leftOverWidth > 0 || rightOverWidth > 0) {
      horizontalHint =
        leftOverWidth >= rightOverWidth
          ? { text: "請往右移動", arrow: "right", key: leftCandidate.key }
          : { text: "請往左移動", arrow: "left", key: rightCandidate.key };
    }
  }

  // 上下置中：最低優先權
  let verticalHint = null;
  if (!horizontalHint) {
    const misalignedByCenterY = candidates.filter((c) => Math.abs(c.dy) > POSITION_TOLERANCE_PERCENT);
    if (misalignedByCenterY.length > 0) {
      const worst = misalignedByCenterY.reduce((a, b) =>
        Math.abs(b.dy) > Math.abs(a.dy) ? b : a
      );
      const dyAdj = worst.dy * VERTICAL_HINT_SIGN;
      verticalHint = {
        text: dyAdj > 0 ? "請往上移動" : "請往下移動",
        arrow: dyAdj > 0 ? "up" : "down",
        key: worst.key,
      };
    }
  }

  return { distanceHint, horizontalHint, verticalHint, isFlipped: false, incomplete: false };
}

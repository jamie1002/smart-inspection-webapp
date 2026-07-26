// 對齊判斷與位置/距離提示純函式
// 從 CameraModule.jsx 抽出。
// 優先權：方位反轉 > 左右中心點偏移+面積不對稱旋轉提示（強制併發後退) > 距離（前後）+ 左右（中心點） > 上下置中

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

    const detArea = (det.xMaxPct - det.xMinPct) * (det.yMaxPct - det.yMinPct);
    const targetArea = (target.xMax - target.xMin) * (target.yMax - target.yMin);
    const areaRatio = targetArea > 0 ? detArea / targetArea : 0;
    const areaError = Math.abs(areaRatio - 1);
    const areaOk =
      areaRatio >= 1 - AREA_TOLERANCE_RATIO && areaRatio <= 1 + AREA_TOLERANCE_RATIO;

    candidates.push({ key, dx, dy, centerX: detCenterX, areaRatio, areaError, areaOk });
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
    // 第二層：左右面積不對稱判斷（旋轉提示）。
    // 使用者站的位置偏向某一側時，近側物件因透視關係面積比例會偏大、
    // 遠側物件面積比例會偏小；此時單純左右移動無法修正角度，
    // 需要「往面積偏大的那一側移動＋往後退」才能同時拉開兩側角度差。
    // 判斷門檻直接沿用面積誤差容許值 AREA_TOLERANCE_RATIO，不另設專用常數。
    const leftCandidate = expectedPlateLeftOfWheel ? plateCandidate : wheelCandidate;
    const rightCandidate = expectedPlateLeftOfWheel ? wheelCandidate : plateCandidate;

    const leftTooLarge = leftCandidate.areaRatio > 1 + AREA_TOLERANCE_RATIO;
    const leftTooSmall = leftCandidate.areaRatio < 1 - AREA_TOLERANCE_RATIO;
    const rightTooLarge = rightCandidate.areaRatio > 1 + AREA_TOLERANCE_RATIO;
    const rightTooSmall = rightCandidate.areaRatio < 1 - AREA_TOLERANCE_RATIO;

    if (leftTooLarge && rightTooSmall) {
      // 左大右小：使用者偏左側 → 往右＋往後，拉開角度差
      horizontalHint = { text: "請往右移動", arrow: "right", key: leftCandidate.key };
      distanceHint = { text: "請往後退一點", arrow: "far", key: leftCandidate.key };
    } else if (rightTooLarge && leftTooSmall) {
      // 右大左小：使用者偏右側 → 往左＋往後
      horizontalHint = { text: "請往左移動", arrow: "left", key: rightCandidate.key };
      distanceHint = { text: "請往後退一點", arrow: "far", key: rightCandidate.key };
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

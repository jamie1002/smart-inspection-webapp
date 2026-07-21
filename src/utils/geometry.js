// 影像裁切幾何相關純函式（單一真實來源）
// CameraFlow、services/models、CameraCalibrationView 皆共用此檔，
// 消除 0719 文件記載的「CameraDebugView 需手動同步」風險。
//
// 🔧 已移除旋轉修正邏輯：直接以感測器回報的原始寬高計算裁切尺寸。
//   切勿重新加入 ctx.rotate / isLandscapeFeed，會破壞模型座標與引導框一致性。

import { DISPLAY_CROP_RATIO } from "../constants/detection";

// cropRatio：寬/高。未傳時退回 DISPLAY_CROP_RATIO（9:16，向下相容舊呼叫端）。
// 呼叫端要與取景框顯示比例一致，否則模型偵測座標會對不上畫面（見 constants/aspectRatios.js）。
export function computeDisplayCropGeometry(rawW, rawH, cropRatio = DISPLAY_CROP_RATIO) {
    let cropW = rawW;
    let cropH = rawH;
    const currentRatio = rawW / rawH;

    if (currentRatio > cropRatio) {
        cropW = rawH * cropRatio;
    } else {
        cropH = rawW / cropRatio;
    }

    return { cropW, cropH };
}

export function downscaleCanvasIfNeeded(sourceCanvas, maxLongEdge) {
    const { width, height } = sourceCanvas;
    const longEdge = Math.max(width, height);
    if (longEdge <= maxLongEdge) return sourceCanvas;

    const scale = maxLongEdge / longEdge;
    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.round(width * scale);
    outCanvas.height = Math.round(height * scale);
    const ctx = outCanvas.getContext("2d");
    ctx.drawImage(sourceCanvas, 0, 0, outCanvas.width, outCanvas.height);
    return outCanvas;
}

// paddingPercent：相對框自身寬高的外擴比例。
// minPaddingPct：最小外擴（畫面百分點，與框準確度無關），框偏窄時仍保底補足。
export function expandBoxByPercent(xMin, xMax, yMin, yMax, paddingPercent, minPaddingPct = 0) {
    const w = xMax - xMin;
    const h = yMax - yMin;
    const padX = Math.max((w * paddingPercent) / 100, minPaddingPct);
    const padY = Math.max((h * paddingPercent) / 100, minPaddingPct);
    return {
        xMin: xMin - padX,
        xMax: xMax + padX,
        yMin: yMin - padY,
        yMax: yMax + padY,
    };
}

export function cropRegionByPercent(sourceCanvas, xMinPct, xMaxPct, yMinPct, yMaxPct) {
    const { width, height } = sourceCanvas;
    const clamp = (v) => Math.min(100, Math.max(0, v));
    const x = (clamp(xMinPct) / 100) * width;
    const y = (clamp(yMinPct) / 100) * height;
    const w = ((clamp(xMaxPct) - clamp(xMinPct)) / 100) * width;
    const h = ((clamp(yMaxPct) - clamp(yMinPct)) / 100) * height;

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = Math.max(1, Math.round(w));
    cropCanvas.height = Math.max(1, Math.round(h));
    const ctx = cropCanvas.getContext("2d");
    ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, cropCanvas.width, cropCanvas.height);
    return cropCanvas;
}

export function letterboxToSquare(sourceCanvas, size) {
    const { width, height } = sourceCanvas;
    const scale = size / Math.max(width, height);
    const newW = Math.round(width * scale);
    const newH = Math.round(height * scale);
    const padLeft = Math.floor((size - newW) / 2);
    const padTop = Math.floor((size - newH) / 2);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = size;
    outCanvas.height = size;
    const ctx = outCanvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(sourceCanvas, 0, 0, width, height, padLeft, padTop, newW, newH);

    return { canvas: outCanvas, scale, padLeft, padTop };
}
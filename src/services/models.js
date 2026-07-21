// 模型載入與推論服務
// - loadCarModel / loadCharModel：載入 TFJS graph model
// - runCarDetection：車體定位（每類別取最高分一框）
// - recognizePlateCharacters：車牌字元辨識（掃全框 → 逐框最高 class → NMS → x 排序）
// 兩套解析邏輯不可混用（見 0719 文件說明）。

import * as tf from "@tensorflow/tfjs";
import {
    MODEL_URL,
    CHAR_MODEL_URL,
    CLASS_NAMES,
    CHAR_CLASS_NAMES,
    CONFIDENCE_THRESHOLD,
    CHAR_CONFIDENCE_THRESHOLD,
    CHAR_NMS_IOU_THRESHOLD,
    CHAR_CROP_PADDING_PERCENT,
    CHAR_INPUT_SIZE,
    DETECTION_INPUT_SIZE,
} from "../constants/detection";
import {
    computeDisplayCropGeometry,
    expandBoxByPercent,
    cropRegionByPercent,
    letterboxToSquare,
} from "../utils/geometry";

export function loadCarModel() {
    return tf.loadGraphModel(MODEL_URL);
}

export function loadCharModel() {
    return tf.loadGraphModel(CHAR_MODEL_URL);
}

// 將 video 目前畫面前處理進 640×640 正方形 canvas（依 cropRatio 裁切 + letterbox，無旋轉修正）
// cropRatio 需與拍照輸出、取景框顯示比例一致（見 constants/aspectRatios.js），
// 否則模型偵測座標會對不上畫面。回傳換算所需的幾何參數，供座標還原。
function preprocessForDetection(video, canvas, cropRatio) {
    const rawW = video.videoWidth;
    const rawH = video.videoHeight;
    const { cropW, cropH } = computeDisplayCropGeometry(rawW, rawH, cropRatio);

    const size = DETECTION_INPUT_SIZE;
    const scale = size / Math.max(cropW, cropH);
    const newW = Math.round(cropW * scale);
    const newH = Math.round(cropH * scale);
    const padLeft = Math.floor((size - newW) / 2);
    const padTop = Math.floor((size - newH) / 2);

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, newW, newH);
    ctx.clip();
    ctx.translate(size / 2, size / 2);
    ctx.scale(scale, scale);
    ctx.drawImage(video, -rawW / 2, -rawH / 2, rawW, rawH);
    ctx.restore();

    return { cropW, cropH, scale, padLeft, padTop };
}

// 車體定位：回傳 { license_plate:{conf,xMinPct,...}, wheel:{...} }（百分比座標）
// cropRatio：目前選定的取景比例（3:4 或 9:16 的 w/h），未傳時 preprocessForDetection
// 會再退回 computeDisplayCropGeometry 的預設值（9:16，向下相容）。
export function runCarDetection(video, model, canvas, cropRatio) {
    const { cropW, cropH, scale, padLeft, padTop } = preprocessForDetection(video, canvas, cropRatio);

    return tf.tidy(() => {
        const inputTensor = tf.browser.fromPixels(canvas).toFloat().div(255.0).expandDims(0);
        const output = model.execute(inputTensor);
        const parsed = output.squeeze([0]).transpose([1, 0]);
        const data = parsed.arraySync();

        const rawResults = {};
        for (let classId = 0; classId < CLASS_NAMES.length; classId++) {
            let best = null;
            for (let i = 0; i < data.length; i++) {
                const conf = data[i][4 + classId];
                if (conf > CONFIDENCE_THRESHOLD && (!best || conf > best.conf)) {
                    best = { conf, cx: data[i][0], cy: data[i][1], w: data[i][2], h: data[i][3] };
                }
            }
            if (best) {
                const x1 = best.cx - best.w / 2;
                const y1 = best.cy - best.h / 2;
                const x2 = best.cx + best.w / 2;
                const y2 = best.cy + best.h / 2;

                const cropX1 = (x1 - padLeft) / scale;
                const cropY1 = (y1 - padTop) / scale;
                const cropX2 = (x2 - padLeft) / scale;
                const cropY2 = (y2 - padTop) / scale;

                rawResults[CLASS_NAMES[classId]] = {
                    conf: best.conf,
                    xMinPct: (cropX1 / cropW) * 100,
                    xMaxPct: (cropX2 / cropW) * 100,
                    yMinPct: (cropY1 / cropH) * 100,
                    yMaxPct: (cropY2 / cropH) * 100,
                };
            }
        }
        return rawResults;
    });
}

// 車牌字元辨識：回傳 { text, confidence } 或 null
export async function recognizePlateCharacters(charModel, sourceCanvas, plateDetection) {
    if (!charModel || !plateDetection) return null;

    const expanded = expandBoxByPercent(
        plateDetection.xMinPct,
        plateDetection.xMaxPct,
        plateDetection.yMinPct,
        plateDetection.yMaxPct,
        CHAR_CROP_PADDING_PERCENT
    );
    const plateCanvas = cropRegionByPercent(
        sourceCanvas,
        expanded.xMin,
        expanded.xMax,
        expanded.yMin,
        expanded.yMax
    );

    const { canvas: inputCanvas, scale, padLeft } = letterboxToSquare(plateCanvas, CHAR_INPUT_SIZE);

    const rawBoxesData = tf.tidy(() => {
        const inputTensor = tf.browser.fromPixels(inputCanvas).toFloat().div(255.0).expandDims(0);
        const output = charModel.execute(inputTensor);
        const parsed = output.squeeze([0]).transpose([1, 0]);
        return parsed.arraySync();
    });

    const candidates = [];
    for (let i = 0; i < rawBoxesData.length; i++) {
        const row = rawBoxesData[i];
        let bestClassId = -1;
        let bestConf = 0;
        for (let c = 0; c < CHAR_CLASS_NAMES.length; c++) {
            const conf = row[4 + c];
            if (conf > bestConf) {
                bestConf = conf;
                bestClassId = c;
            }
        }
        if (bestConf > CHAR_CONFIDENCE_THRESHOLD) {
            const [cx, cy, w, h] = row;
            candidates.push({
                classId: bestClassId,
                conf: bestConf,
                x1: cx - w / 2,
                y1: cy - h / 2,
                x2: cx + w / 2,
                y2: cy + h / 2,
            });
        }
    }

    if (candidates.length === 0) return null;

    const boxesTensor = tf.tensor2d(candidates.map((c) => [c.y1, c.x1, c.y2, c.x2]));
    const scoresTensor = tf.tensor1d(candidates.map((c) => c.conf));

    const nmsIndices = await tf.image.nonMaxSuppressionAsync(
        boxesTensor,
        scoresTensor,
        50,
        CHAR_NMS_IOU_THRESHOLD,
        CHAR_CONFIDENCE_THRESHOLD
    );
    const keepIndices = await nmsIndices.array();
    boxesTensor.dispose();
    scoresTensor.dispose();
    nmsIndices.dispose();

    const kept = keepIndices.map((idx) => {
        const c = candidates[idx];
        const realX1 = (c.x1 - padLeft) / scale;
        const realX2 = (c.x2 - padLeft) / scale;
        return {
            char: CHAR_CLASS_NAMES[c.classId],
            conf: c.conf,
            xCenter: (realX1 + realX2) / 2,
        };
    });

    kept.sort((a, b) => a.xCenter - b.xCenter);

    const text = kept.map((k) => k.char).join("");
    const avgConf = kept.reduce((sum, k) => sum + k.conf, 0) / kept.length;

    return { text, confidence: avgConf };
}
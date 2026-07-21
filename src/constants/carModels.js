// 車款登錄表
// ⚠️ 目前僅 Altis。每個車款的引導素材（線稿 outlines + 去背 ghost）由
//    scripts/build_guides.py 依 Roboflow COCO 標註產生，輸出到：
//      constants/guides/<slug>.js（OUTLINES）、assets/guide/<slug>/{front,rear}_ghost.png
//    偵測目標框 templates 目前沿用共用的 GUIDE_TEMPLATES（Altis 實測值）；
//    若新車款尺寸差異大，可用腳本印出的 TEMPLATES 另存並在此指定。
//
// 新增車款步驟（詳見 docs/05 §8.2）：
//   1) 用 Roboflow 標「左前」「左後」兩角度（car/license_plate/wheel），各匯出 COCO
//   2) python scripts/build_guides.py --slug <slug> --label <Label> --front <coco> --rear <coco>
//   3) 依腳本印出的片段，在下方 CAR_MODELS 加一個 key
import { GUIDE_TEMPLATES } from "./guideTemplates";
import { OUTLINES as altisOutlines } from "./guides/altis";
import altisFront from "../assets/guide/altis/front_ghost.png";
import altisRear from "../assets/guide/altis/rear_ghost.png";

export const CAR_MODELS = {
  Altis: {
    label: "Altis",
    templates: GUIDE_TEMPLATES,
    outlines: altisOutlines,
    ghost: { front: altisFront, rear: altisRear },
  },
};

export const CAR_MODEL_LIST = Object.keys(CAR_MODELS);
export const DEFAULT_CAR_MODEL = "Altis";

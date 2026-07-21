// 車款登錄表
// ⚠️ 目前僅 Altis。每個車款、每個取景比例（見 constants/aspectRatios.js）各自一組
//    引導素材（線稿 outlines + 去背 ghost + 偵測目標框 templates），由
//    scripts/build_guides.py 依 Roboflow COCO 標註產生，輸出到：
//      constants/guides/<slug>.js         （9:16，OUTLINES + TEMPLATES，原有預設不加後綴）
//      constants/guides/<slug>-3-4.js     （3:4，OUTLINES + TEMPLATES）
//      assets/guide/<slug>/{front,rear}_ghost.png       （9:16）
//      assets/guide/<slug>/3-4/{front,rear}_ghost.png   （3:4）
//
// 新增車款步驟（詳見 docs/05 §8.2）：
//   1) 用 Roboflow 標「左前」「左後」兩角度（car/license_plate/wheel），各匯出 COCO
//   2) python scripts/build_guides.py --slug <slug> --label <Label> --ratio <9:16|3:4> --front <coco> --rear <coco>
//      （標註圖片本身若沒去背，另加 --front-ghost/--rear-ghost 指向同一張照片的去背版本）
//   3) 依腳本印出的片段，在下方 CAR_MODELS[<Label>].variants 補上對應比例的 key
import { GUIDE_TEMPLATES } from "./guideTemplates";
import { OUTLINES as altisOutlines916 } from "./guides/altis";
import altisFront916 from "../assets/guide/altis/front_ghost.png";
import altisRear916 from "../assets/guide/altis/rear_ghost.png";

import { OUTLINES as altisOutlines34, TEMPLATES as altisTemplates34 } from "./guides/altis-3-4";
import altisFront34 from "../assets/guide/altis/3-4/front_ghost.png";
import altisRear34 from "../assets/guide/altis/3-4/rear_ghost.png";

export const CAR_MODELS = {
    Altis: {
        label: "Altis",
        variants: {
            "3:4": {
                templates: altisTemplates34,
                outlines: altisOutlines34,
                ghost: { front: altisFront34, rear: altisRear34 },
            },
            "9:16": {
                templates: GUIDE_TEMPLATES,
                outlines: altisOutlines916,
                ghost: { front: altisFront916, rear: altisRear916 },
            },
        },
    },
};

export const CAR_MODEL_LIST = Object.keys(CAR_MODELS);
export const DEFAULT_CAR_MODEL = "Altis";
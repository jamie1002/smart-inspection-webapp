#!/usr/bin/env python3
"""
build_guides.py — 由 Roboflow COCO 標註產生「取景引導」素材（可重複執行）

用途：每個車款需要一組取景引導資料。此腳本吃該車款「左前」與「左後」兩個角度的
Roboflow COCO 匯出（各含 car / license_plate / wheel 三類的筆刷遮罩），自動產生：

  1) src/constants/guides/<slug>.js   —— 車身/車輪平滑線稿 + 車牌方框（4 方位，右側鏡像）
  2) src/assets/guide/<slug>/front_ghost.png、rear_ghost.png
        —— 半透明用去背圖，車牌區域已擦透明
  3) 印到終端機：建議的 templates（車牌/車輪偵測目標框，% 座標）與要貼進
        src/constants/carModels.js 的登錄片段

右前 = 左前水平鏡像、右後 = 左後水平鏡像（車體左右對稱），故只需標「左前」「左後」兩角度。

相依套件：
  pip install pycocotools opencv-python-headless numpy pillow --break-system-packages

用法：
  python scripts/build_guides.py \
      --slug altis --label Altis \
      --front "/path/to/左前.coco" \
      --rear  "/path/to/左後.coco" \
      --repo-root .

（COCO 資料夾需含 train/_annotations.coco.json 與該張標註圖片。）
"""
import argparse, glob, json, os
import numpy as np
import cv2
from PIL import Image
from pycocotools import mask as M

VIEW_W, VIEW_H = 720, 1280
GHOST_WIDTH = 480          # ghost 輸出寬度（縮圖省容量）
CAR_POINTS = 56            # 車身輪廓重採樣點數（越多越貼、越少越圓滑）
WHEEL_POINTS = 28
PLATE_DILATE = 9           # 擦車牌時外擴的 kernel 大小


# ---------- 幾何：重採樣 + Catmull-Rom 平滑 ----------
def resample_closed(pts, n):
    pts = pts.astype(float)
    d = np.sqrt(((np.roll(pts, -1, 0) - pts) ** 2).sum(1))
    cum = np.concatenate([[0], np.cumsum(d)])
    total = cum[-1]
    out = []
    for t in np.linspace(0, total, n, endpoint=False):
        i = max(0, min(np.searchsorted(cum, t) - 1, len(pts) - 1))
        seg = cum[i + 1] - cum[i] if i + 1 < len(cum) else 1
        f = (t - cum[i]) / seg if seg > 0 else 0
        out.append(pts[i] * (1 - f) + pts[(i + 1) % len(pts)] * f)
    return np.array(out)


def catmull_rom(pts):
    n = len(pts)
    d = f"M{pts[0][0]:.1f} {pts[0][1]:.1f}"
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6.0
        c2 = p2 - (p3 - p1) / 6.0
        d += f"C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d + "Z"


# ---------- COCO 解析 ----------
def load_coco(coco_dir):
    j = json.load(open(glob.glob(os.path.join(coco_dir, "train", "_annotations.coco.json"))[0]))
    cats = {c["id"]: c["name"] for c in j["categories"]}
    img_path = glob.glob(os.path.join(coco_dir, "train", "*.png"))[0]
    return j, cats, img_path


def biggest_contour(mask):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return max(cnts, key=cv2.contourArea).reshape(-1, 2)


def extract(coco_dir):
    """回傳 {car,plate,wheel} 的 SVG path 及 {plate,wheel} 的 bbox（供 templates）。"""
    j, cats, _ = load_coco(coco_dir)
    paths, bboxes = {}, {}
    for a in j["annotations"]:
        name = cats[a["category_id"]]
        if name == "wheel-license-plate":
            continue
        m = M.decode(a["segmentation"]).astype(np.uint8)
        c = biggest_contour(m)
        bboxes[name] = a["bbox"]  # [x,y,w,h]
        if name == "license_plate":
            poly = cv2.approxPolyDP(c.reshape(-1, 1, 2), 1.0, True).reshape(-1, 2)
            paths[name] = "M" + "L".join(f"{int(x)} {int(y)}" for x, y in poly) + "Z"
        else:
            npts = CAR_POINTS if name == "car" else WHEEL_POINTS
            paths[name] = catmull_rom(resample_closed(c, npts))
    return paths, bboxes


def make_ghost(coco_dir, out_path):
    j, cats, img_path = load_coco(coco_dir)
    im = Image.open(img_path).convert("RGBA")
    arr = np.array(im)
    for a in j["annotations"]:
        if cats[a["category_id"]] == "license_plate":
            plate = M.decode(a["segmentation"]).astype(np.uint8)
            plate = cv2.dilate(plate, np.ones((PLATE_DILATE, PLATE_DILATE), np.uint8), iterations=2)
            arr[plate > 0, 3] = 0  # 車牌擦透明
    im2 = Image.fromarray(arr, "RGBA")
    w = GHOST_WIDTH
    h = round(im2.height * (w / im2.width))
    im2 = im2.resize((w, h), Image.LANCZOS)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im2.save(out_path)


# ---------- templates（偵測目標框，% 座標） ----------
def bbox_to_pct(b):
    x, y, w, h = b
    return dict(xMin=round(x / VIEW_W * 100, 1), xMax=round((x + w) / VIEW_W * 100, 1),
                yMin=round(y / VIEW_H * 100, 1), yMax=round((y + h) / VIEW_H * 100, 1))


def mirror_box(box):
    return dict(xMin=round(100 - box["xMax"], 1), xMax=round(100 - box["xMin"], 1),
                yMin=box["yMin"], yMax=box["yMax"])


LABELS = {"front_left": "左前", "left_rear": "左後", "right_rear": "右後", "right_front": "右前"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True, help="車款檔名代號（小寫，如 altis）")
    ap.add_argument("--label", required=True, help="車款顯示名稱（如 Altis）")
    ap.add_argument("--front", required=True, help="左前角度 COCO 資料夾")
    ap.add_argument("--rear", required=True, help="左後角度 COCO 資料夾")
    ap.add_argument("--repo-root", default=".", help="專案根目錄")
    args = ap.parse_args()

    root = args.repo_root
    fl_paths, fl_box = extract(args.front)
    lr_paths, lr_box = extract(args.rear)

    # 1) outlines JS
    def entry(paths, mirror):
        return (f'    car: "{paths["car"]}",\n'
                f'    plate: "{paths["license_plate"]}",\n'
                f'    wheel: "{paths["wheel"]}",\n'
                f'    mirror: {"true" if mirror else "false"},\n')
    js = ["// 由 scripts/build_guides.py 產生 —— 請勿手改，改標註後重跑腳本。",
          f'// 車款：{args.label}　viewBox {VIEW_W}x{VIEW_H}（=9:16）',
          "export const OUTLINES = {"]
    for pos, (paths, mirror) in {
        "front_left": (fl_paths, False), "left_rear": (lr_paths, False),
        "right_front": (fl_paths, True), "right_rear": (lr_paths, True),
    }.items():
        js.append(f"  {pos}: {{\n{entry(paths, mirror)}  }},")
    js.append("};\n")
    out_js = os.path.join(root, "src", "constants", "guides", f"{args.slug}.js")
    os.makedirs(os.path.dirname(out_js), exist_ok=True)
    open(out_js, "w").write("\n".join(js))
    print(f"[寫入] {out_js}")

    # 2) ghosts
    gdir = os.path.join(root, "src", "assets", "guide", args.slug)
    make_ghost(args.front, os.path.join(gdir, "front_ghost.png"))
    make_ghost(args.rear, os.path.join(gdir, "rear_ghost.png"))
    print(f"[寫入] {gdir}/front_ghost.png, rear_ghost.png")

    # 3) 印出建議 templates + carModels 片段
    fl_plate, fl_wheel = bbox_to_pct(fl_box["license_plate"]), bbox_to_pct(fl_box["wheel"])
    lr_plate, lr_wheel = bbox_to_pct(lr_box["license_plate"]), bbox_to_pct(lr_box["wheel"])
    tpl = {
        "front_left": ("左前", fl_plate, fl_wheel),
        "left_rear": ("左後", lr_plate, lr_wheel),
        "right_rear": ("右後", mirror_box(lr_plate), mirror_box(lr_wheel)),
        "right_front": ("右前", mirror_box(fl_plate), mirror_box(fl_wheel)),
    }
    print("\n===== 建議 templates（貼進 constants/guides/%s.js 或 guideTemplates；偵測目標框）=====" % args.slug)
    print("export const TEMPLATES = {")
    for pos, (label, p, w) in tpl.items():
        print(f'  {pos}: {{ label: "{label}",')
        print(f'    licensePlate: {{ xMin: {p["xMin"]}, xMax: {p["xMax"]}, yMin: {p["yMin"]}, yMax: {p["yMax"]} }},')
        print(f'    wheel: {{ xMin: {w["xMin"]}, xMax: {w["xMax"]}, yMin: {w["yMin"]}, yMax: {w["yMax"]} }} }},')
    print("};")
    print("\n===== 加進 src/constants/carModels.js =====")
    print(f'import {{ OUTLINES as {args.slug}Outlines }} from "./guides/{args.slug}";')
    print(f'// （若此車款需要自己的偵測框，另 import TEMPLATES；否則沿用共用 GUIDE_TEMPLATES）')
    print(f'import {args.slug}Front from "../assets/guide/{args.slug}/front_ghost.png";')
    print(f'import {args.slug}Rear from "../assets/guide/{args.slug}/rear_ghost.png";')
    print(f'// CAR_MODELS["{args.label}"] = {{ label: "{args.label}", templates: GUIDE_TEMPLATES,')
    print(f'//   outlines: {args.slug}Outlines, ghost: {{ front: {args.slug}Front, rear: {args.slug}Rear }} }};')


if __name__ == "__main__":
    main()

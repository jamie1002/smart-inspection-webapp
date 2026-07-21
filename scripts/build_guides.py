#!/usr/bin/env python3
"""
build_guides.py — 由 Roboflow COCO 標註產生「取景引導」素材（可重複執行）

用途：每個車款、每個取景比例（見 src/constants/aspectRatios.js）需要一組取景引導資料。
此腳本吃該車款「左前」與「左後」兩個角度的 Roboflow COCO 匯出（各含 car / license_plate /
wheel 三類的筆刷遮罩），自動產生：

  1) src/constants/guides/<slug>.js       —— 9:16（預設比例，檔名不加後綴，向下相容既有檔案）
     src/constants/guides/<slug>-3-4.js   —— 3:4（--ratio 3:4 時）
        車身/車輪平滑線稿 + 車牌方框（4 方位，右側鏡像）
  2) src/assets/guide/<slug>/front_ghost.png、rear_ghost.png              —— 9:16
     src/assets/guide/<slug>/3-4/front_ghost.png、rear_ghost.png          —— 3:4
        半透明用去背圖，車牌區域已擦透明
  3) 印到終端機：建議的 templates（車牌/車輪偵測目標框，% 座標）與要貼進
        src/constants/carModels.js 的 variants[<ratio>] 登錄片段

右前 = 左前水平鏡像、右後 = 左後水平鏡像（車體左右對稱），故只需標「左前」「左後」兩角度。
⚠️ 不同比例的取景框裁切範圍不同，同一車款要跑兩次（--ratio 9:16 與 --ratio 3:4），
   標註素材（COCO）通常也需依該比例的實際取景畫面重新標，不能兩比例共用同一份標註。

相依套件：
  pip install pycocotools opencv-python-headless numpy pillow --break-system-packages

用法：
  python scripts/build_guides.py \
      --slug altis --label Altis --ratio 3:4 \
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

# 取景比例登錄：需與 src/constants/aspectRatios.js 的 ASPECT_RATIOS 保持一致
RATIO_PRESETS = {
    "9:16": (720, 1280),
    "3:4": (720, 960),
}

VIEW_W, VIEW_H = RATIO_PRESETS["9:16"]  # main() 依 --ratio 覆寫
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
    img_meta = j["images"][0]
    size_hw = (img_meta["height"], img_meta["width"])
    return j, cats, img_path, size_hw


def ann_to_mask(ann, size_hw):
    """支援兩種 Roboflow 匯出格式：筆刷標註（RLE dict）與多邊形標註（polygon list）。
    做法沿用 pycocotools COCO API 的 annToMask 慣例，兩種格式都轉成同一份 binary mask，
    避免不同標註工具/類別混用時（同一批匯出常常一部分是 RLE、一部分是 polygon）腳本直接壞掉。
    """
    seg = ann["segmentation"]
    h, w = size_hw
    if isinstance(seg, list):
        # 多邊形：可能不只一個 part，逐一轉 RLE 再合併
        rles = M.frPyObjects(seg, h, w)
        rle = M.merge(rles)
    elif isinstance(seg.get("counts"), list):
        # 未壓縮 RLE（counts 是純數字陣列）
        rle = M.frPyObjects(seg, h, w)
    else:
        # 已是壓縮 RLE（筆刷標註常見格式）
        rle = seg
    return M.decode(rle)


def biggest_contour(mask):
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    return max(cnts, key=cv2.contourArea).reshape(-1, 2)


def extract(coco_dir):
    """回傳 {car,plate,wheel} 的 SVG path（已縮放到 VIEW_W x VIEW_H viewBox 座標系）、
    {plate,wheel} 的 bbox（原圖像素座標，未縮放）、以及該標註圖片的實際 (img_w, img_h)。
    ⚠️ 標註圖片的像素尺寸不一定等於 VIEW_W x VIEW_H（例如這批 3:4 素材是 1080x1440，
    而 viewBox 用 720x960），所以路徑座標一定要先按 (VIEW_W/img_w, VIEW_H/img_h) 縮放，
    不能直接假設兩者相等，否則畫出來的線稿/目標框會整個跑版（超出 100%、甚至變負值）。
    bbox 則保留原圖像素座標，交給呼叫端用「實際圖片尺寸」換算百分比（見 bbox_to_pct）。
    """
    j, cats, _, size_hw = load_coco(coco_dir)
    img_h, img_w = size_hw
    sx, sy = VIEW_W / img_w, VIEW_H / img_h
    paths, bboxes = {}, {}
    for a in j["annotations"]:
        name = cats[a["category_id"]]
        if name == "wheel-license-plate":
            continue
        m = ann_to_mask(a, size_hw).astype(np.uint8)
        c = biggest_contour(m).astype(np.float32)
        c_scaled = c * np.array([sx, sy], dtype=np.float32)
        bboxes[name] = a["bbox"]  # [x,y,w,h]，原圖像素座標
        if name == "license_plate":
            poly = cv2.approxPolyDP(c_scaled.reshape(-1, 1, 2), 1.0, True).reshape(-1, 2)
            paths[name] = "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in poly) + "Z"
        else:
            npts = CAR_POINTS if name == "car" else WHEEL_POINTS
            paths[name] = catmull_rom(resample_closed(c_scaled, npts))
    return paths, bboxes, (img_w, img_h)


def make_ghost(coco_dir, out_path, source_override=None):
    """預設直接用 COCO 標註圖（img_path）當 ghost 底圖，erase 車牌後輸出——這是舊流程假設
    「標註圖片本身就是已去背的 Photoroom 圖」時的做法。
    ⚠️ 如果標註是在另一張「有背景的真實照片」上做的（例如方便標註而選了場景照，另外有一張
    去背的 hero 照片才是真正要當 ghost 用的），要用 source_override 指定那張已去背 PNG 的路徑；
    腳本仍用 COCO 的車牌遮罩去擦，只是擦在 override 圖片上，兩張圖必須是同一張原始照片
    （只差有沒有去背），否則遮罩位置會對不上。
    """
    j, cats, img_path, size_hw = load_coco(coco_dir)
    img_h, img_w = size_hw
    if source_override:
        img_path = source_override
    im = Image.open(img_path).convert("RGBA")
    arr = np.array(im)
    out_h, out_w = arr.shape[0], arr.shape[1]
    for a in j["annotations"]:
        if cats[a["category_id"]] == "license_plate":
            plate = ann_to_mask(a, size_hw).astype(np.uint8)
            if (out_h, out_w) != (img_h, img_w):
                # override 圖片尺寸跟 COCO 標註圖不同，遮罩需先縮放對齊（理論上不該發生，保險起見）
                plate = cv2.resize(plate, (out_w, out_h), interpolation=cv2.INTER_NEAREST)
            plate = cv2.dilate(plate, np.ones((PLATE_DILATE, PLATE_DILATE), np.uint8), iterations=2)
            arr[plate > 0, 3] = 0  # 車牌擦透明
    im2 = Image.fromarray(arr, "RGBA")
    w = GHOST_WIDTH
    h = round(im2.height * (w / im2.width))
    im2 = im2.resize((w, h), Image.LANCZOS)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im2.save(out_path)


# ---------- templates（偵測目標框，% 座標） ----------
# ⚠️ 用「標註圖片實際尺寸」換算百分比，不是 VIEW_W/VIEW_H（那是 SVG viewBox 的任意繪圖單位，
#    兩者不保證相等）。只要標註圖片本身就是目標比例的完整取景畫面，用實際像素換算才會準。
def bbox_to_pct(b, img_w, img_h):
    x, y, w, h = b
    return dict(xMin=round(x / img_w * 100, 1), xMax=round((x + w) / img_w * 100, 1),
                yMin=round(y / img_h * 100, 1), yMax=round((y + h) / img_h * 100, 1))


def mirror_box(box):
    return dict(xMin=round(100 - box["xMax"], 1), xMax=round(100 - box["xMin"], 1),
                yMin=box["yMin"], yMax=box["yMax"])


def check_ratio_match(img_w, img_h, ratio_key, tag):
    """標註圖片比例應與 --ratio 目標比例一致（誤差 >1% 印警告），避免誤用錯張照片。"""
    expected = RATIO_PRESETS[ratio_key][0] / RATIO_PRESETS[ratio_key][1]
    actual = img_w / img_h
    if abs(expected - actual) / expected > 0.01:
        print(f"⚠️ 警告：{tag} 標註圖片 {img_w}x{img_h}（比例 {actual:.3f}）"
              f"與 --ratio {ratio_key} 目標比例（{expected:.3f}）不符，% 座標可能失真，請確認來源照片。")


LABELS = {"front_left": "左前", "left_rear": "左後", "right_rear": "右後", "right_front": "右前"}


def main():
    global VIEW_W, VIEW_H

    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", required=True, help="車款檔名代號（小寫，如 altis）")
    ap.add_argument("--label", required=True, help="車款顯示名稱（如 Altis）")
    ap.add_argument("--ratio", choices=list(RATIO_PRESETS.keys()), default="9:16",
                     help="取景比例，需與 src/constants/aspectRatios.js 的 key 一致（預設 9:16）")
    ap.add_argument("--front", required=True, help="左前角度 COCO 資料夾")
    ap.add_argument("--rear", required=True, help="左後角度 COCO 資料夾")
    ap.add_argument("--front-ghost", default=None,
                     help="【選填】左前已去背 PNG 路徑，與 --front 標註圖是同一張照片但已去背時使用；"
                          "未指定則沿用舊行為，直接拿 --front 標註圖當 ghost 底圖（適合標註圖本身就已去背的情況）")
    ap.add_argument("--rear-ghost", default=None,
                     help="【選填】左後已去背 PNG 路徑，用法同 --front-ghost")
    ap.add_argument("--repo-root", default=".", help="專案根目錄")
    args = ap.parse_args()

    VIEW_W, VIEW_H = RATIO_PRESETS[args.ratio]
    ratio_slug = args.ratio.replace(":", "-")  # "9-16" / "3-4"，檔名/資料夾不可用冒號（Windows）
    # 9:16 是既有預設，維持原檔名不加後綴，向下相容既有 constants/guides/<slug>.js；
    # 其他比例（目前只有 3:4）另外加後綴，兩者並存互不覆蓋。
    is_default_ratio = args.ratio == "9:16"

    root = args.repo_root
    fl_paths, fl_box, fl_size = extract(args.front)
    lr_paths, lr_box, lr_size = extract(args.rear)
    check_ratio_match(*fl_size, args.ratio, "--front")
    check_ratio_match(*lr_size, args.ratio, "--rear")

    # templates（偵測目標框，% 座標；用標註圖實際尺寸換算，見 bbox_to_pct）
    fl_plate, fl_wheel = bbox_to_pct(fl_box["license_plate"], *fl_size), bbox_to_pct(fl_box["wheel"], *fl_size)
    lr_plate, lr_wheel = bbox_to_pct(lr_box["license_plate"], *lr_size), bbox_to_pct(lr_box["wheel"], *lr_size)
    tpl = {
        "front_left": ("左前", fl_plate, fl_wheel),
        "left_rear": ("左後", lr_plate, lr_wheel),
        "right_rear": ("右後", mirror_box(lr_plate), mirror_box(lr_wheel)),
        "right_front": ("右前", mirror_box(fl_plate), mirror_box(fl_wheel)),
    }

    # 1) outlines + templates 寫進同一支 JS（兩者是同一批標註產生的一組資料，放一起維護，
    #    也避免像先前那樣得手動把終端機印出的 TEMPLATES 複製貼上進 carModels.js，減少人為抄錯風險）
    def entry(paths, mirror):
        return (f'    car: "{paths["car"]}",\n'
                f'    plate: "{paths["license_plate"]}",\n'
                f'    wheel: "{paths["wheel"]}",\n'
                f'    mirror: {"true" if mirror else "false"},\n')
    js = ["// 由 scripts/build_guides.py 產生 —— 請勿手改，改標註後重跑腳本。",
          f'// 車款：{args.label}　比例 {args.ratio}　viewBox {VIEW_W}x{VIEW_H}',
          "export const OUTLINES = {"]
    for pos, (paths, mirror) in {
        "front_left": (fl_paths, False), "left_rear": (lr_paths, False),
        "right_front": (fl_paths, True), "right_rear": (lr_paths, True),
    }.items():
        js.append(f"  {pos}: {{\n{entry(paths, mirror)}  }},")
    js.append("};\n")
    js.append("export const TEMPLATES = {")
    for pos, (label, p, w) in tpl.items():
        js.append(f'  {pos}: {{ label: "{label}",')
        js.append(f'    licensePlate: {{ xMin: {p["xMin"]}, xMax: {p["xMax"]}, yMin: {p["yMin"]}, yMax: {p["yMax"]} }},')
        js.append(f'    wheel: {{ xMin: {w["xMin"]}, xMax: {w["xMax"]}, yMin: {w["yMin"]}, yMax: {w["yMax"]} }} }},')
    js.append("};\n")
    slug_file = args.slug if is_default_ratio else f"{args.slug}-{ratio_slug}"
    out_js = os.path.join(root, "src", "constants", "guides", f"{slug_file}.js")
    os.makedirs(os.path.dirname(out_js), exist_ok=True)
    open(out_js, "w").write("\n".join(js))
    print(f"[寫入] {out_js}（含 OUTLINES 與 TEMPLATES 兩個 export）")

    # 2) ghosts
    gdir = os.path.join(root, "src", "assets", "guide", args.slug)
    if not is_default_ratio:
        gdir = os.path.join(gdir, ratio_slug)
    make_ghost(args.front, os.path.join(gdir, "front_ghost.png"), source_override=args.front_ghost)
    make_ghost(args.rear, os.path.join(gdir, "rear_ghost.png"), source_override=args.rear_ghost)
    print(f"[寫入] {gdir}/front_ghost.png, rear_ghost.png")

    # 3) 印出要貼進 carModels.js 的片段（只有 import／variants 這幾行仍要手動貼，
    #    因為那是跨檔案的登錄動作，不像 templates 那樣能直接寫進同一支輸出檔）
    print(f"\n===== 加進 src/constants/carModels.js（{args.ratio}） =====")
    print(f'import {{ OUTLINES as {args.slug}Outlines{ratio_slug.replace("-", "")}, TEMPLATES as {args.slug}Templates{ratio_slug.replace("-", "")} }} from "./guides/{slug_file}";')
    ghost_import_path = f"../assets/guide/{args.slug}/front_ghost.png" if is_default_ratio else f"../assets/guide/{args.slug}/{ratio_slug}/front_ghost.png"
    ghost_import_path_rear = f"../assets/guide/{args.slug}/rear_ghost.png" if is_default_ratio else f"../assets/guide/{args.slug}/{ratio_slug}/rear_ghost.png"
    print(f'import {args.slug}Front{ratio_slug.replace("-", "")} from "{ghost_import_path}";')
    print(f'import {args.slug}Rear{ratio_slug.replace("-", "")} from "{ghost_import_path_rear}";')
    print(f'// CAR_MODELS["{args.label}"].variants["{args.ratio}"] = {{')
    print(f'//   templates: {args.slug}Templates{ratio_slug.replace("-", "")},')
    print(f'//   outlines: {args.slug}Outlines{ratio_slug.replace("-", "")},')
    print(f'//   ghost: {{ front: {args.slug}Front{ratio_slug.replace("-", "")}, rear: {args.slug}Rear{ratio_slug.replace("-", "")} }},')
    print(f'// }};')


if __name__ == "__main__":
    main()
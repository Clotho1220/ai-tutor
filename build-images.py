# -*- coding: utf-8 -*-
"""把「Gogo English」專案生成好的插畫母版轉成網頁用的 WebP，放進 images/。

母版是 1254×1254 PNG，527 張共 1.3 GB，不可能推上 GitHub Pages。
轉成 512px WebP 之後全部約 16 MB。

母版一律不含文字（單字由前端顯示在圖片外），所以這裡只做縮圖與轉檔。

用法：
    python build-images.py
    python build-images.py --size 640 --quality 85
    python build-images.py --gogo "D:/somewhere/Gogo English/圖片提示詞"
"""

import argparse
import json
import os
import sys

DEFAULT_GOGO = os.path.join("..", "Gogo English", "圖片提示詞")
OUT_DIR = "images"


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--gogo", default=DEFAULT_GOGO)
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--quality", type=int, default=82)
    parser.add_argument("--force", action="store_true",
                        help="已存在的檔也重轉")
    args = parser.parse_args()

    try:
        from PIL import Image
    except ImportError:
        sys.exit("需要 Pillow：pip install Pillow")

    here = os.path.dirname(os.path.abspath(__file__))
    gogo = args.gogo if os.path.isabs(args.gogo) else os.path.join(here, args.gogo)
    prompts_path = os.path.join(gogo, "prompts.json")
    if not os.path.isfile(prompts_path):
        sys.exit("找不到 %s" % prompts_path)

    with open(prompts_path, encoding="utf-8") as handle:
        items = json.load(handle)["items"]

    # 母版分冊放在 圖片生成/第N冊/，先建一張「檔名 → 完整路徑」的表
    sources = {}
    masters = os.path.join(gogo, "圖片生成")
    for root, _dirs, files in os.walk(masters):
        for name in files:
            if name.lower().endswith(".png"):
                sources[name] = os.path.join(root, name)

    out_dir = os.path.join(here, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)

    done = skipped = missing = 0
    missing_names = []
    total_bytes = 0

    for item in items:
        png = item["filename"]
        webp = os.path.splitext(png)[0] + ".webp"
        target = os.path.join(out_dir, webp)

        if png not in sources:
            missing += 1
            missing_names.append(png)
            continue
        if os.path.exists(target) and not args.force:
            skipped += 1
            total_bytes += os.path.getsize(target)
            continue

        image = Image.open(sources[png]).convert("RGB")
        image.thumbnail((args.size, args.size), Image.LANCZOS)
        image.save(target, "webp", quality=args.quality, method=6)
        total_bytes += os.path.getsize(target)
        done += 1
        if done % 50 == 0:
            print("  ... 已轉 %d 張" % done, flush=True)

    print("✅ images/：新轉 %d、沿用 %d、母版缺 %d，合計 %.1f MB"
          % (done, skipped, missing, total_bytes / 1024 / 1024))
    if missing_names:
        print("⚠️ 這些提示詞還沒生成圖：")
        for name in missing_names:
            print("   ", name)


if __name__ == "__main__":
    main()

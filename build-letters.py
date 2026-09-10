# -*- coding: utf-8 -*-
"""把「Gogo English」專案的 52 張字母卡轉成網頁用的 WebP，並寫出 letters.json。

字母卡是 1254×1524 的直式卡片，卡面上已經有：左上角的字母徽章（Aa）、插圖、
下方的英文單字與中文。所以前端只要把整張圖顯示出來就好，不用另外壓字。

一個字母兩張卡（apple／ant），26 個字母共 52 張。字母與例字取自
「Gogo English」教材資料的 phonics 欄位，與 units.json 同一個來源。

    python build-letters.py
    python build-letters.py --force        # 已存在的檔也重轉

輸出：
    images/letters/A_apple.webp ...        （52 張）
    letters.json                           （字母、唸法提示、兩個例字）
"""

import argparse
import io
import json
import os
import re
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
CARDS = os.path.join(os.path.dirname(HERE), "Gogo English", "圖片提示詞", "圖卡", "字母卡")
GOGO = os.path.join(os.path.dirname(HERE), "Gogo English", "教材資料", "gogo1.json")
OUT_DIR = os.path.join(HERE, "images", "letters")
OUT_JSON = os.path.join(HERE, "letters.json")

# 每個字母「唸起來像什麼」的中文提示。給模型用的，讓它能用孩子聽得懂的方式帶著唸
# （模型自己發的是真正的英文音，這裡只是要它怎麼用中文解釋）。
# 使用者的例子：A 唸「阿」、B 唸「ㄅ」。
SOUNDS = {
    "A": "ㄚ（阿）", "B": "ㄅ", "C": "ㄎ", "D": "ㄉ", "E": "ㄝ",
    "F": "ㄈ", "G": "ㄍ", "H": "ㄏ", "I": "ㄧ", "J": "ㄐ（就）",
    "K": "ㄎ", "L": "ㄌ", "M": "ㄇ", "N": "ㄋ", "O": "ㄛ",
    "P": "ㄆ", "Q": "ㄎㄨ", "R": "ㄖ", "S": "ㄙ", "T": "ㄊ",
    "U": "ㄜ", "V": "ㄈㄨ（咬下嘴唇）", "W": "ㄨ", "X": "ㄎㄙ",
    "Y": "ㄧ（一）", "Z": "ㄗ",
}


def read_pairs():
    """從教材資料讀出 26 個字母各自的兩個例字。"""
    with io.open(GOGO, encoding="utf-8") as handle:
        gogo = json.load(handle)
    letters = OrderedDict()
    for unit in gogo["units"]:
        for entry in unit.get("phonics") or []:
            name = entry.get("letter", "")
            # 第 1 冊的 phonics 是「Aa」這種；第 2／3 冊是音標，不在這裡處理
            if not re.fullmatch(r"[A-Z][a-z]", name):
                continue
            words = [(w.get("en", ""), w.get("zh", "")) for w in entry.get("words") or []]
            if words:
                letters[name] = words
    return letters


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--size", type=int, default=640,
                        help="長邊縮到幾 px（卡片是直式的，字要看得清楚）")
    parser.add_argument("--quality", type=int, default=82)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    try:
        from PIL import Image
    except ImportError:
        sys.exit("需要 Pillow：pip install Pillow")

    if not os.path.isdir(CARDS):
        sys.exit("找不到字母卡資料夾：%s" % CARDS)

    letters = read_pairs()
    os.makedirs(OUT_DIR, exist_ok=True)

    out = OrderedDict()
    out["_說明"] = ("字母卡（A–Z，每個字母兩個例字）。由 AI tutor/build-letters.py 產生，不要手改。"
                   "image 是 images/letters/ 裡的檔名；卡面上已經有字母、英文單字與中文，"
                   "前端整張顯示即可。sound 是給模型用的中文唸法提示。")
    rows = []
    done = skipped = 0
    for name, words in letters.items():
        head = name[0]
        entry = OrderedDict([
            ("letter", name),
            ("sound", SOUNDS.get(head, "")),
            ("words", []),
        ])
        for english, chinese in words:
            png = os.path.join(CARDS, "%s_%s.png" % (head, english))
            if not os.path.isfile(png):
                sys.exit("缺少字母卡：%s" % png)
            webp_name = "%s_%s.webp" % (head, english)
            target = os.path.join(OUT_DIR, webp_name)
            stale = (os.path.exists(target)
                     and os.path.getmtime(png) > os.path.getmtime(target))
            if not os.path.exists(target) or args.force or stale:
                image = Image.open(png).convert("RGB")
                image.thumbnail((args.size, args.size), Image.LANCZOS)
                image.save(target, "webp", quality=args.quality, method=6)
                done += 1
            else:
                skipped += 1
            entry["words"].append(OrderedDict([
                ("english", english),
                ("chinese", chinese),
                ("image", "letters/" + webp_name),
            ]))
        rows.append(entry)
    out["letters"] = rows

    io.open(OUT_JSON, "w", encoding="utf-8", newline="\n").write(
        json.dumps(out, ensure_ascii=False, indent=1) + "\n")

    total = sum(os.path.getsize(os.path.join(OUT_DIR, f))
                for f in os.listdir(OUT_DIR) if f.endswith(".webp"))
    print("✅ images/letters/：新轉 %d、沿用 %d，合計 %.1f MB"
          % (done, skipped, total / 1024 / 1024))
    print("✅ letters.json：%d 個字母、%d 張卡"
          % (len(rows), sum(len(r["words"]) for r in rows)))
    missing = [r["letter"] for r in rows if not r["sound"]]
    if missing:
        print("⚠️ 這些字母沒有中文唸法提示：", missing)


if __name__ == "__main__":
    main()

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
    letters.json                           （字母、常見的音、兩個例字）
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

# 每個字母最常見的那個音（自然發音法的短音）。
#
# 2026-09-10 使用者定案：**不要標注音**。第一版寫成「ㄚ（阿）」「ㄅ」，
# 那是要模型「用中文解釋」，但模型會直接把注音當成台詞唸出來，孩子聽到的
# 就變成中文的ㄚ而不是英文的 /æ/。改成給音標，讓模型用英文把音發出來，
# 畫面上也不再印任何發音標記。
#
# 例字本身就是最好的錨點（apple 開頭的那個音），所以指令會用當張卡的例字。
SOUNDS = {
    "A": "/æ/", "B": "/b/", "C": "/k/", "D": "/d/", "E": "/ɛ/",
    "F": "/f/", "G": "/g/", "H": "/h/", "I": "/ɪ/", "J": "/dʒ/",
    "K": "/k/", "L": "/l/", "M": "/m/", "N": "/n/", "O": "/ɑ/",
    "P": "/p/", "Q": "/kw/", "R": "/r/", "S": "/s/", "T": "/t/",
    "U": "/ʌ/", "V": "/v/", "W": "/w/", "X": "/ks/",
    "Y": "/j/", "Z": "/z/",
}

# 例字錨不住那個音的字母，另外給一個說法。
# X 的兩個例字（x-ray／exercise）開頭都是字母名 /ɛks/，不是 /ks/ 這個音。
SOUND_NOTES = {
    "X": "這個音在字尾，像 box、fox 最後的那個音",
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
                   "前端整張顯示即可。sound 是這個字母最常見的音（音標，給模型用英文發出來的，"
                   "不會印在畫面上）；soundNote 只有例字錨不住那個音的字母才有。")
    rows = []
    done = skipped = 0
    for name, words in letters.items():
        head = name[0]
        entry = OrderedDict([
            ("letter", name),
            ("sound", SOUNDS.get(head, "")),
            ("soundNote", SOUND_NOTES.get(head, "")),
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
        print("⚠️ 這些字母沒有發音資料：", missing)


if __name__ == "__main__":
    main()

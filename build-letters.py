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
# 教材（培生 New Gogo Loves English 1）的 Alphabet 軌切點：每張卡在整軌裡的第幾秒到第幾秒。
# 真人錄的字母名與音，TTS 怎麼調都比不上——2026-09-10 使用者提議改用這個。
CUTS_JSON = os.path.join(HERE, "pearson-cuts.json")

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

# ---- 旁白要怎麼唸 ----
#
# 2026-09-10 一整天的教訓，濃縮成三條：
#   1. 字母名不能讓 TTS 猜（A、E 會被後面的音帶偏），要釘死。
#   2. 沒有一個引擎唸得好所有的音：flash_v2 子音還行，短母音與摩擦音（A E U R S X Z）
#      要靠 turbo_v2 或 eleven_v3 的原生 IPA。而且 X 要「turbo 的字母名＋v3 的音」。
#   3. 只有使用者的耳朵能判。所以每一段都要能單獨換、單獨重錄。
#
# 因此旁白拆成**三段獨立小檔**：字母名、音、單字，各自指定引擎與寫法，
# 播放時由 letter-player.js 接起來、段與段之間留 0.7 秒。
# 使用者在試聽室（tests/letter-audio-lab*.html）挑的結果就寫在下面三張表裡。

FLASH, TURBO, V3 = "eleven_flash_v2", "eleven_turbo_v2", "eleven_v3"


def phoneme(word, arpabet):
    return '<phoneme alphabet="cmu-arpabet" ph="%s">%s</phoneme>' % (arpabet, word)


# 字母名：(引擎, 文字)。母音用音標／IPA 釘死，子音純文字（套 phoneme 反而壞）。
LETTER_NAME_ARPA = {"A": "EY1", "E": "IY1", "I": "AY1", "O": "OW1", "U": "Y UW1"}
NAME_SPEC = {
    "A": (TURBO, phoneme("A", "EY1")),
    "E": (V3, "/iː/"),
    "I": (FLASH, phoneme("I", "AY1")),
    "O": (FLASH, phoneme("O", "OW1")),
    "U": (TURBO, phoneme("U", "Y UW1")),
    "X": (TURBO, "X"),
    "Z": (V3, "/ziː/"),
}

# 音：(引擎, 文字)。使用者 2026-09-10 兩輪試聽挑的。
SOUND_SPEC = {
    "A": (TURBO, phoneme("a", "AE1")),   "B": (FLASH, phoneme("b", "B AH0")),
    "C": (FLASH, "kuh"),                  "D": (FLASH, phoneme("d", "D AH0")),
    "E": (V3, "/ɛ/"),                     "F": (FLASH, phoneme("f", "F AH0")),
    "G": (FLASH, phoneme("g", "G AH0")),  "H": (FLASH, phoneme("h", "HH AH0")),
    "I": (FLASH, "ih"),                   "J": (FLASH, "juh"),
    "K": (FLASH, phoneme("k", "K AH0")),  "L": (FLASH, phoneme("l", "L AH0")),
    "M": (FLASH, phoneme("m", "M AH0")),  "N": (FLASH, "nnn"),
    "O": (FLASH, "ah"),                   "P": (FLASH, "puh"),
    "Q": (FLASH, "kwuh"),                 "R": (V3, "/ɹː/"),
    "S": (V3, "/sː/"),                    "T": (FLASH, phoneme("t", "T AH0")),
    "U": (TURBO, phoneme("u", "AH1")),    "V": (FLASH, phoneme("v", "V AH0")),
    "W": (FLASH, "wuh"),                  "X": (V3, "/ks/"),
    "Y": (FLASH, phoneme("y", "Y AH0")),  "Z": (V3, "/z/"),
}

# 例字：flash_v2；被 TTS 唸歪的釘音標
WORD_SAY = {"igloo": "IH1 G L UW0", "lion": "L AY1 AH0 N"}

# 使用者要「短一點」的音：那一段放快一點
SOUND_SPEED = {"K": 0.9, "O": 0.9}


def segments_for(head, english):
    """這張卡的三段：(role, 引擎, 要唸的文字, 檔名, 速度)。字母名與音兩張卡共用同一個檔。"""
    name_model, name_text = NAME_SPEC.get(head, (FLASH, head))
    sound_model, sound_text = SOUND_SPEC[head]
    word = english[0].upper() + english[1:]
    word_text = phoneme(word, WORD_SAY[english.lower()]) if english.lower() in WORD_SAY else word
    slug = english.replace(" ", "_")
    return [
        ("name", name_model, name_text + ".", "letters/seg/%s_name.mp3" % head, 0.8),
        ("sound", sound_model, sound_text + ".", "letters/seg/%s_sound.mp3" % head, SOUND_SPEED.get(head, 0.8)),
        ("word", FLASH, word_text + ".", "letters/seg/%s_%s.mp3" % (head, slug), 0.8),
    ]


def say_plain(letter, head, english):
    """純文字版（瀏覽器語音備援、與檢查用）。"""
    return "%s ... %s ... %s." % (head, head.lower(), english)


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
    cuts = {}
    if os.path.isfile(CUTS_JSON):
        with io.open(CUTS_JSON, encoding="utf-8") as handle:
            cuts = json.load(handle).get("cuts", {})

    out = OrderedDict()
    out["_說明"] = ("字母卡（A–Z，每個字母兩個例字）。由 AI tutor/build-letters.py 產生，不要手改。"
                   "image 是 images/letters/ 裡的檔名；卡面上已經有字母、英文單字與中文，"
                   "前端整張顯示即可。sound 是這個字母最常見的音（音標，給模型用英文發出來的，"
                   "不會印在畫面上）；soundNote 只有例字錨不住那個音的字母才有。"
                   "audio 是三段小檔（字母名／音／單字）的順序清單，segments 記每段的引擎與寫法；"
                   "say 是純文字版（瀏覽器語音備援）。")
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
            segs = segments_for(head, english)
            cut = cuts.get("%s_%s" % (head, english))
            entry["words"].append(OrderedDict([
                ("english", english),
                ("chinese", chinese),
                ("image", "letters/" + webp_name),
                ("say", say_plain(name, head, english)),
                ("expect", "%s %s" % (head, english)),
                # 首選：教材整軌裡的一段（真人）。播放器先看這個，沒有才用三段 TTS。
                ("clip", OrderedDict([("file", cut["file"]), ("start", cut["start"]), ("end", cut["end"])])
                 if cut else None),
                # 三段獨立小檔，播放時接起來（順序就是唸的順序）
                ("audio", [file for _role, _model, _text, file, _speed in segs]),
                ("segments", [OrderedDict([("role", role), ("model", model), ("text", text),
                                           ("file", file), ("speed", speed)])
                              for role, model, text, file, speed in segs]),
            ]))
        rows.append(entry)
    out["letters"] = rows

    io.open(OUT_JSON, "w", encoding="utf-8", newline="\n").write(
        json.dumps(out, ensure_ascii=False, indent=1) + "\n")

    total = sum(os.path.getsize(os.path.join(OUT_DIR, f))
                for f in os.listdir(OUT_DIR) if f.endswith(".webp"))
    print("✅ images/letters/：新轉 %d、沿用 %d，合計 %.1f MB"
          % (done, skipped, total / 1024 / 1024))
    with_clip = sum(1 for r in rows for w in r["words"] if w.get("clip"))
    print("✅ letters.json：%d 個字母、%d 張卡（其中 %d 張有教材真人音的切點）"
          % (len(rows), sum(len(r["words"]) for r in rows), with_clip))
    missing = [r["letter"] for r in rows if not r["sound"]]
    if missing:
        print("⚠️ 這些字母沒有發音資料：", missing)


if __name__ == "__main__":
    main()

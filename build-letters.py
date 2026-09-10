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

# ---- 旁白要怎麼唸 ----
#
# 2026-09-10 實聽兩輪的教訓：
#   第 1 輪  「A, a. aa. Apple.」 → 有些卡字母唸兩次、有些不唸；整體太快
#   第 2 輪  「A ... aa ... Apple.」→ A、E 這種母音字母，字母名被唸成了它的音
#           （TTS 看到後面接著 aa 就把前面的 A 也猜成 /æ/）
#
# 所以字母名不能再靠 TTS 猜，改用 ElevenLabs 的 phoneme 標籤直接指定音標
# （CMU Arpabet；只有 eleven_flash_v2 支援）。母音的「音」也一樣指定，
# 因為 aa／eh／ih 這種拼法本身就跟字母名長得太像。
# 子音的音維持文字拼法（fff、mmm、buh）——那幾個實聽沒被抱怨，
# 而且單獨一個子音音素丟給 TTS 常常短到聽不見。
#
# 段落之間用 <break> 留停頓（v2 模型支援，最多 3 秒），不再用 ...。

# 26 個字母的「名字」（Arpabet）。這是這一版真正要修的東西。
LETTER_NAME = {
    "A": "EY1", "B": "B IY1", "C": "S IY1", "D": "D IY1", "E": "IY1",
    "F": "EH1 F", "G": "JH IY1", "H": "EY1 CH", "I": "AY1", "J": "JH EY1",
    "K": "K EY1", "L": "EH1 L", "M": "EH1 M", "N": "EH1 N", "O": "OW1",
    "P": "P IY1", "Q": "K Y UW1", "R": "AA1 R", "S": "EH1 S", "T": "T IY1",
    "U": "Y UW1", "V": "V IY1", "W": "D AH1 B AH0 L Y UW0", "X": "EH1 K S",
    "Y": "W AY1", "Z": "Z IY1",
}

# 母音字母的「音」也用 Arpabet 指定（apple 的 /æ/、egg 的 /ɛ/ ...）
VOWEL_SOUND = {"A": "AE1", "E": "EH1", "I": "IH1", "O": "AA1", "U": "AH1"}

# 子音的「音」用自然發音法教材慣用的拼法。能延長的就拉長（fff、mmm），
# 塞音只能帶一個很輕的 uh（buh、kuh）——這是 TTS 的限制，人聲錄音不會這樣。
# **這張表是拿來調的**：錄完聽過覺得哪個音怪，改這裡再用 --only 補錄就好。
SOUND_SAY = {
    "B": "buh", "C": "kuh", "D": "duh", "F": "fff", "G": "guh", "H": "huh",
    "J": "juh", "K": "kuh", "L": "lll", "M": "mmm", "N": "nnn", "P": "puh",
    "Q": "kwuh", "R": "rrr", "S": "sss", "T": "tuh", "V": "vvv", "W": "wuh",
    "X": "ks", "Y": "yuh", "Z": "zzz",
}

PAUSE = '<break time="0.7s" />'

# 例字本身被 TTS 唸歪的，也用 phoneme 釘住。
# igloo：第 2、3 輪轉回文字都是「I... Blue」，跟母音的音接在一起就糊掉。
WORD_SAY = {"igloo": "IH1 G L UW0"}


def phoneme(word, arpabet):
    return '<phoneme alphabet="cmu-arpabet" ph="%s">%s</phoneme>' % (arpabet, word)


def say_line(letter, head, english, first):
    """這張卡要唸的一句話：字母名 → 音 → 單字（使用者定案的教法），每張卡都一樣。

    第 3 輪（Scribe 轉回文字對過）：phoneme 標籤把母音的字母名修好了，
    但套在子音上反而壞掉——H 唸成 A、N 唸成 and、S 唸成 say、Y 唸成 we。
    子音的字母名純文字 TTS 本來就唸得對，所以只有母音走 phoneme。
    """
    name = phoneme(head, LETTER_NAME[head]) if head in VOWEL_SOUND else head
    sound = (phoneme(head.lower(), VOWEL_SOUND[head]) if head in VOWEL_SOUND
             else SOUND_SAY.get(head, ""))
    word = english[0].upper() + english[1:] if english else english
    if english.lower() in WORD_SAY:
        word = phoneme(word, WORD_SAY[english.lower()])
    return (" " + PAUSE + " ").join(part for part in [name, sound, word] if part) + "."


def say_plain(letter, head, english):
    """同一句的純文字版（給檢查用：預期聽到的字）。"""
    return "%s %s" % (head, english)


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
                   "不會印在畫面上）；soundNote 只有例字錨不住那個音的字母才有。"
                   "say 是旁白要唸的那一句（字母→音→單字），audio 是 build-letter-audio.py 產出的檔名。")
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
                ("say", say_line(name, head, english, not entry["words"])),
                ("expect", say_plain(name, head, english)),
                ("audio", "letters/%s_%s.mp3" % (head, english)),
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

# -*- coding: utf-8 -*-
"""units.json 產生器：Gogo English 專案的教材資料 + 本專案的人工整理 → units.json

取代舊的 build-units.py（Lesson data.xlsx）。教材的唯一真實來源改成
「Gogo English」專案的 教材資料/gogo{1,2,3}.json，那份是從課本翻拍照片逐頁核對的。

本專案只保留 units-overlay.json，裡面是 gogo 沒有、但程式需要的東西：
  - patterns：模板化句型（`What's this? / It's a/an [object].`）
    lesson-plan.js 的 splitPattern() 靠「空白/空白」拆問答，gogo 的具體例句拆不出來
  - theme：給模型用的英文主題句
  - 單字的詞性標記與例句

用法：
    python build-units-from-gogo.py
    python build-units-from-gogo.py --gogo "D:/somewhere/Gogo English/教材資料"
"""

import argparse
import json
import os
import re
import sys

BOOKS = (1, 2, 3)
DEFAULT_GOGO = os.path.join("..", "Gogo English", "教材資料")
DEFAULT_PROMPTS = os.path.join("..", "Gogo English", "圖片提示詞", "prompts.json")

# 圖庫的 kind 是「畫圖用」的分類（red 和 soccer 都算 obj），
# 句型代換需要的是語法類別，所以只拿它當最後一層退路。
KIND_TO_SLOT = {
    "action": "action", "adj": "adjective", "animal": "animal",
    "food": "food", "person": "person", "place": "place",
    "prep": "preposition", "obj": "object",
    "text": "other", "scene": "other",
}

# 詞性標記比 kind 準，優先用
POS_TO_SLOT = {
    "(v.)": "action", "(v-ing)": "action_ing", "(adj.)": "adjective",
    "(prep.)": "preposition", "(prep. phrase)": "preposition",
    "(num.)": "number", "(pron.)": "possessive",
    "(n. possessive)": "possessive", "(int.)": "greeting",
}

# Review 單元彙整前面三個正課單元（課本設計就是 Review 1 = Unit 1~3）
REVIEW_SPAN = 3


def bare(value):
    """`desk (n.)` → `desk`；用來跨資料源比對同一個字。"""
    return re.sub(r"\([^)]*\)", "", str(value or "")).strip().lower()


def load_image_index(path):
    """prompts.json → 兩張表：單字圖與句型情境圖。

    母版是 PNG，網頁吃的是 build-images.py 轉出來的 WebP，所以副檔名要換掉。
    """
    if not os.path.isfile(path):
        return {}, {}
    with open(path, encoding="utf-8") as handle:
        items = json.load(handle)["items"]
    words, scenes = {}, {}
    for item in items:
        webp = os.path.splitext(item["filename"])[0] + ".webp"
        if item.get("group") == "scene":
            scenes.setdefault((item["book"], item["unit"]), []).append({
                "lines": item.get("en", ""),
                "image": webp,
            })
        elif item.get("group") == "word":
            words[(item["book"], item["unit"], bare(item.get("en", "")))] = {
                "image": webp,
                "kind": item.get("kind", ""),
                "askType": item.get("ask_type", ""),
            }
    return words, scenes


def word_slot(display, unit_over, english, kind):
    """這個字可以拿去填哪一種句型空格。

    順序：個別覆寫 → 單元層級 → 詞性標記 → 圖庫 kind。
    課本每個單元的單字幾乎都是同一類，所以單元層級就蓋掉九成。
    """
    overrides = unit_over.get("wordSlots") or {}
    if bare(english) in overrides:
        return overrides[bare(english)]
    if unit_over.get("wordSlot"):
        return unit_over["wordSlot"]
    tag = pos_tag(display)
    if tag in POS_TO_SLOT:
        return POS_TO_SLOT[tag]
    return KIND_TO_SLOT.get(kind, "other")


def pos_tag(display):
    """從 `desk (n.)` 取出 `(n.)`；沒有標記就回空字串。"""
    found = re.search(r"\([^)]*\)", str(display or ""))
    return found.group(0) if found else ""


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def pairs(items):
    """gogo 的 {en, zh} 統一成本專案的 {english, chinese}。"""
    return [{"english": i.get("en", ""), "chinese": i.get("zh", "")} for i in items or []]


def variants(word):
    """課本會用複數形（balloons／presents），舊資料寫單數形，兩邊要對得起來。"""
    key = bare(word)
    forms = [key]
    if key.endswith("es"):
        forms += [key[:-2], key[:-1]]
    elif key.endswith("s"):
        forms.append(key[:-1])
    else:
        forms += [key + "s", key + "es"]
    return forms


def convert_words(vocabulary, overlay_words, unit_over, image_key, images):
    """gogo 單字表 + overlay 的詞性與例句 + 圖庫的圖檔與分類。"""
    words = []
    for entry in vocabulary or []:
        english = entry.get("en", "")
        extra = next((overlay_words[form] for form in variants(english)
                      if form in overlay_words), {})
        display = extra.get("display", "")
        picture = images.get(image_key + (bare(english),), {})
        word = {
            # 顯示形態一律以課本（gogo）為準，只從 overlay 借詞性標記
            "english": "%s %s" % (english, pos_tag(display)) if pos_tag(display) else english,
            "chinese": entry.get("zh", ""),
            "example": extra.get("example", ""),
            "slot": word_slot(display, unit_over, english, picture.get("kind", "")),
            "image": picture.get("image", ""),
            "askType": picture.get("askType", ""),
        }
        if unit_over.get("plural"):
            word["plural"] = True
        words.append(word)
    return words


def convert_phonics(phonics):
    return [{"letter": p.get("letter", ""), "words": pairs(p.get("words"))}
            for p in phonics or []]


def convert_unit(book_num, gogo_unit, overlay, images, scenes):
    book_name = "Book %d" % book_num
    num = gogo_unit["unit"]
    over = overlay["units"].get("%s|%s" % (book_name, num), {})
    unit_code = "u%02d" % num if isinstance(num, int) else str(num)
    patterns = [dict(pattern) for pattern in over.get("patterns", [])]
    if over.get("plural"):
        for pattern in patterns:
            pattern["plural"] = True
    return {
        "book": book_name,
        "num": num,
        "type": "unit",
        "title": gogo_unit.get("title", ""),
        "pages": gogo_unit.get("pages", ""),
        "function": gogo_unit.get("function", ""),
        "desc": over.get("desc", ""),
        "theme": over.get("theme", ""),
        "patterns": patterns,
        "words": convert_words(gogo_unit.get("vocabulary"), over.get("words", {}),
                               over, (book_num, unit_code), images),
        # 句型情境圖：一張圖就能決定答案，用來練「別人這樣問你要怎麼回答」
        "scenes": scenes.get((book_num, unit_code), []),
        "grammar": [{"point": g.get("point", ""), "note": g.get("note", "")}
                    for g in gogo_unit.get("grammar") or []],
        "phonics": convert_phonics(gogo_unit.get("phonics")),
        "expressions": pairs(gogo_unit.get("key_expressions")),
        "notes": gogo_unit.get("notes", "") or "",
    }


def build_review_unit(book_num, gogo_unit, covered):
    """Review 單元在課本裡是空殼（沒有自己的單字與句型），內容由前三個單元彙整。

    彙整而不是隨機抽樣，是因為 lesson-plan.js 本來就會把單字攤到五天；
    這裡給滿，攤下去每天大約 4~7 個複習項目。
    """
    book_name = "Book %d" % book_num
    nums = [u["num"] for u in covered]
    titles = [u["title"] for u in covered]
    span = "、".join("Unit %s" % n for n in nums)

    words, seen_words = [], set()
    for unit in covered:
        for word in unit["words"]:
            key = bare(word["english"])
            if key and key not in seen_words:
                seen_words.add(key)
                words.append(word)

    patterns, seen_patterns = [], set()
    for unit in covered:
        for pattern in unit["patterns"]:
            key = pattern.get("english", "")
            if key and key not in seen_patterns:
                seen_patterns.add(key)
                patterns.append(pattern)

    return {
        "book": book_name,
        "num": gogo_unit["unit"],
        "type": "review",
        "reviewOf": nums,
        "title": gogo_unit.get("title", ""),
        "pages": gogo_unit.get("pages", ""),
        "function": "複習 %s" % span,
        "desc": "本單元把 %s 學過的句型與單字整理起來再練一次，不教新內容。" % span,
        "theme": ("Review of %s — the student practices everything from %s again, "
                  "with no new material.（複習 %s：把前面學過的句型與單字再練一次。）"
                  % (", ".join(titles), span, span)),
        "patterns": patterns,
        "words": words,
        "scenes": [s for unit in covered for s in unit.get("scenes", [])],
        "grammar": [g for unit in covered for g in unit["grammar"]],
        "phonics": [p for unit in covered for p in unit["phonics"]],
        "expressions": [e for unit in covered for e in unit["expressions"]],
        "notes": gogo_unit.get("notes", "") or "",
    }


def build_book(book_num, gogo, overlay, images, scenes, report):
    units, recent = [], []
    for gogo_unit in gogo["units"]:
        kind = gogo_unit.get("type")
        if kind == "unit":
            unit = convert_unit(book_num, gogo_unit, overlay, images, scenes)
            units.append(unit)
            recent.append(unit)
        elif kind == "review":
            covered = recent[-REVIEW_SPAN:]
            if not covered:
                report.append("⚠️ Book %d %s 前面沒有正課單元可彙整，已略過"
                              % (book_num, gogo_unit.get("title")))
                continue
            units.append(build_review_unit(book_num, gogo_unit, covered))
            recent = []
        # intro / bonus / culture 目前不進課程流程
    return {"name": "Book %d" % book_num, "units": units}


def main():
    # Windows 主控台預設是 cp950，訊息裡的中文與符號會炸掉
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--gogo", default=DEFAULT_GOGO,
                        help="Gogo English 專案的「教材資料」資料夾")
    parser.add_argument("--prompts", default=DEFAULT_PROMPTS,
                        help="圖庫的 prompts.json（提供每個字的圖檔與分類）")
    parser.add_argument("--out", default="units.json")
    parser.add_argument("--overlay", default="units-overlay.json")
    args = parser.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    gogo_dir = args.gogo if os.path.isabs(args.gogo) else os.path.join(here, args.gogo)
    if not os.path.isdir(gogo_dir):
        sys.exit("找不到教材資料夾：%s" % gogo_dir)

    overlay = load_json(os.path.join(here, args.overlay))
    prompts_path = (args.prompts if os.path.isabs(args.prompts)
                    else os.path.join(here, args.prompts))
    images, scenes = load_image_index(prompts_path)
    report = []
    if not images:
        report.append("⚠️ 找不到 %s，單字不會帶圖片；圖片辨識練習會沒有圖可用"
                      % prompts_path)
    books = [build_book(n, load_json(os.path.join(gogo_dir, "gogo%d.json" % n)),
                        overlay, images, scenes, report)
             for n in BOOKS]

    out_path = os.path.join(here, args.out)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"source": "Gogo English/教材資料 + units-overlay.json",
                   "books": books}, handle, ensure_ascii=False, indent=2)
        handle.write("\n")

    # ---- 產出報告：哪些單字還缺例句、哪些單元還沒有 theme ----
    missing_example, missing_theme, missing_image, unslotted = [], [], [], []
    for book in books:
        for unit in book["units"]:
            label = "%s U%s" % (book["name"], unit["num"])
            if not unit["theme"]:
                missing_theme.append(label)
            if unit["type"] == "review":
                continue          # 複習單元的字沿用原單元，不重複計
            for word in unit["words"]:
                if not word["example"]:
                    missing_example.append("%s %s" % (label, word["english"]))
                if not word.get("image"):
                    missing_image.append("%s %s" % (label, word["english"]))
                if word.get("slot", "other") == "other":
                    unslotted.append("%s %s" % (label, word["english"]))

    total_units = sum(len(b["units"]) for b in books)
    total_words = sum(len(u["words"]) for b in books for u in b["units"]
                      if u["type"] == "unit")
    print("✅ %s：%d 個單元（正課 %d + 複習 %d），正課單字 %d 個"
          % (args.out, total_units,
             sum(1 for b in books for u in b["units"] if u["type"] == "unit"),
             sum(1 for b in books for u in b["units"] if u["type"] == "review"),
             total_words))
    for line in report:
        print(line)
    scene_count = sum(len(u.get("scenes", [])) for b in books for u in b["units"]
                      if u["type"] == "unit")
    print("   圖片：單字圖 %d／%d，句型情境圖 %d"
          % (total_words - len(missing_image), total_words, scene_count))
    if missing_image:
        print("⚠️ 沒有圖的單字（%d）：%s" % (len(missing_image), "、".join(missing_image[:20])))
    if unslotted:
        print("ℹ️ 不參與句型代換的字（%d）：%s" % (len(unslotted), "、".join(unslotted)))
    if missing_theme:
        print("⚠️ 缺英文 theme（%d）：%s" % (len(missing_theme), "、".join(missing_theme)))
    if missing_example:
        print("ℹ️ 缺例句的單字（%d 個）——例句是選填，模型仍會拿到中文意思與單元句型："
              % len(missing_example))
        for line in missing_example:
            print("   ", line)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""
把 Lesson data.xlsx（Gogo English 各冊單元分析）轉成 units.json，供網頁直接載入。

用法（在專案資料夾執行）：
    python build-units.py

支援兩種欄位標籤寫法：
    Book 2 風格：主題情境 / 目標句型 / 目標單字
    Book 3 風格：Theme / Sentence Pattern / Word（含 Word (Noun)、Word (Verb)）
單元標題列可為「Unit 3: ...」或「🌟 Unit 3: ...」，標題下方可有一行中文說明。
"""
# ⚠️ 已停用（v3.18）
# units.json 的產生方式已改為 build-units-from-gogo.py，教材來源是
# 「Gogo English」專案的 教材資料/gogo{1,2,3}.json（課本翻拍照片逐頁核對）。
# 這支腳本產出的資料比較薄（第 2 冊每個單元只有 2 個單字，且沒有 Review 單元），
# 直接執行會把 units.json 覆寫回舊版。留著只為保存當初的解析邏輯。
import sys as _sys
if "--i-know-this-is-deprecated" not in _sys.argv:
    _sys.exit("此腳本已停用，請改用：python build-units-from-gogo.py"
              "\n（若真的要跑舊版，加上 --i-know-this-is-deprecated）")

import json
import re
import openpyxl

SRC = "Lesson data.xlsx"
OUT = "units.json"

UNIT_RE = re.compile(r"^\s*(?:🌟\s*)?Unit\s+(\d+)\s*[:：]\s*(.+?)\s*$")

THEME_LABELS = {"theme", "主題情境"}
PATTERN_LABELS = {"sentence pattern", "目標句型"}
WORD_PREFIXES = ("word", "vocabulary", "目標單字", "單字")


def clean(v):
    if v is None:
        return ""
    s = str(v).replace("**", "").strip()
    return "" if s in {"-", "—", "N/A", "n/a"} else s


def parse_sheet(ws, book_name):
    units, cur = [], None
    for row in ws.iter_rows(values_only=True):
        a, b, c, d = (list(row) + [None] * 4)[:4]
        a_s = clean(a)
        if not a_s:
            continue

        m = UNIT_RE.match(a_s)
        if m:
            cur = {"book": book_name, "num": int(m.group(1)), "title": m.group(2),
                   "desc": "", "theme": "", "patterns": [], "words": []}
            units.append(cur)
            continue

        if cur is None or a_s.lower() == "type":
            continue

        label = a_s.lower()
        english, chinese, example = clean(b), clean(c), clean(d)

        # 單元標題下方的中文說明列（只有 A 欄有字）
        if not english and not chinese and not example:
            if not cur["desc"]:
                cur["desc"] = a_s
            continue

        item = {"english": english, "chinese": chinese, "example": example}
        if label in THEME_LABELS:
            cur["theme"] = english + (f"（{chinese}）" if chinese else "")
        elif label in PATTERN_LABELS:
            if english:
                cur["patterns"].append(item)
        elif label.startswith(WORD_PREFIXES):
            if english:
                cur["words"].append(item)
    return units


def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    books = []
    for ws in wb.worksheets:
        units = parse_sheet(ws, ws.title)
        if units:
            books.append({"name": ws.title, "units": units})
            print(f"{ws.title}: {len(units)} 單元, "
                  f"{sum(len(u['patterns']) for u in units)} 句型, "
                  f"{sum(len(u['words']) for u in units)} 單字")

    books.sort(key=lambda b: b["name"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"books": books}, f, ensure_ascii=False, indent=1)
    total = sum(len(b["units"]) for b in books)
    print(f"→ 已寫入 {OUT}（共 {total} 個單元）")


if __name__ == "__main__":
    main()

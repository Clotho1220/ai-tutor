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
import json
import re
import openpyxl

SRC = "Lesson data.xlsx"
OUT = "units.json"

UNIT_RE = re.compile(r"^\s*(?:🌟\s*)?Unit\s+(\d+)\s*[:：]\s*(.+?)\s*$")

THEME_LABELS = {"theme", "主題情境"}
PATTERN_LABELS = {"sentence pattern", "目標句型"}
WORD_PREFIXES = ("word", "目標單字")


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

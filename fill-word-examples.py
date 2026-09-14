# -*- coding: utf-8 -*-
"""把沒有例句的單字補上例句，寫進 units-overlay.json（v3.50）。

來源優先序（都只用教材裡的句子，不自己編）：
  1. 該單元 gogo 的 target_sentences / key_expressions 裡「整字」含這個字的句子
  2. 該單元 overlay 句型的 example（"1. What's this? It's a desk. 2. ..."）裡含這個字的句子
  3. 其他單元的 target_sentences / key_expressions
  4. 用該單元句型的 example 句「換字」：找一句含同槽位單字的例句，把那個字換成這個字（a/an 自動修）
補了什麼、從哪裡來，全部印出來給人抽查。

    py -3 fill-word-examples.py            # 寫入 overlay
    py -3 fill-word-examples.py --dry-run  # 只列不寫
之後要跑 build-units-from-gogo.py 才會進 units.json。
"""
import io
import json
import os
import re
import sys
from collections import OrderedDict

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
GOGO_DIR = os.path.join(os.path.dirname(HERE), "Gogo English", "教材資料")
OVERLAY = os.path.join(HERE, "units-overlay.json")


def bare(s):
    return re.sub(r"\([^)]*\)", "", s or "").strip().lower()


def art(word):
    return "an" if word[:1].lower() in "aeiou" else "a"


def sentences_of(text):
    """"1. What's this? It's a desk. 2. What's this? It's an eraser." → 逐句"""
    parts = re.split(r"\s*\d+\.\s*", text or "")
    out = []
    for part in parts:
        for sent in re.findall(r"[^.!?]+[.!?]", part):
            sent = sent.strip()
            if sent:
                out.append(sent)
    return out


def contains_word(sentence, word):
    return re.search(r"(?<![a-z])" + re.escape(word) + r"(?![a-z])", sentence.lower()) is not None


def pick(sentences, word):
    for sent in sentences:
        if contains_word(sent, word):
            return sent
    return ""


def swap_word(sentence, old, new):
    """把例句裡的舊字換成新字，順便修 a/an。"""
    out = re.sub(r"(?<![a-z])" + re.escape(old) + r"(?![a-z])", new, sentence, flags=re.IGNORECASE)
    out = re.sub(r"\b(a|an)\s+" + re.escape(new) + r"\b",
                 lambda m: "%s %s" % (art(new), new), out, flags=re.IGNORECASE)
    return out


# 自動挑出來但不適合唸給孩子聽的（不是完整句、換字換出怪句、對話兩句黏在一起），人工指定。
# 只用教材裡出現過的句型，不編新句。
OVERRIDES = {
    ("Book 1|1", "hi"): "Hi, Gogo!",
    ("Book 1|1", "bye"): "Bye, Gogo!",
    ("Book 1|2", "table"): "It's a table.",
    ("Book 1|2", "chair"): "It's a chair.",
    ("Book 1|3", "swim"): "Can you swim?",
    ("Book 1|5", "family"): "This is my family.",
    ("Book 1|6", "parent"): "They're my parents.",
    ("Book 1|6", "baby"): "This is the baby.",
    ("Book 2|1", "soup"): "I like soup.",
    ("Book 2|1", "gray"): "It's gray.",
    ("Book 2|2", "sad"): "He's sad.",
    ("Book 2|2", "light"): "It's light.",
    ("Book 2|2", "big"): "I'm big.",
    ("Book 2|2", "small"): "She's small.",
    ("Book 2|3", "badminton"): "I like badminton.",
    ("Book 2|5", "window"): "It's a window.",
    ("Book 2|5", "clock"): "It's a clock.",
    ("Book 2|6", "oranges"): "They're oranges.",
    ("Book 2|7", "in"): "They're in the box.",
    ("Book 2|7", "between"): "It's between the bed and the desk.",
    ("Book 2|9", "two o'clock"): "It's two o'clock.",
    ("Book 2|9", "ten o'clock"): "It's ten o'clock.",
    ("Book 2|11", "spoons"): "You have spoons.",
    ("Book 2|11", "glasses"): "She has glasses.",
}


def main():
    dry = "--dry-run" in sys.argv
    overlay = json.load(io.open(OVERLAY, encoding="utf-8"), object_pairs_hook=OrderedDict)
    gogo_books = {n: json.load(io.open(os.path.join(GOGO_DIR, "gogo%d.json" % n), encoding="utf-8"))
                  for n in (1, 2, 3)}
    all_sentences = []
    for n, book in gogo_books.items():
        for unit in book["units"]:
            for s in (unit.get("target_sentences") or []) + (unit.get("key_expressions") or []):
                all_sentences.append(s.get("en", ""))

    filled, left = [], []
    for n, book in gogo_books.items():
        for unit in book["units"]:
            if unit.get("type") != "unit":
                continue
            key = "Book %d|%s" % (n, unit["unit"])
            over = overlay["units"].setdefault(key, OrderedDict())
            words = over.setdefault("words", OrderedDict())
            local = [s.get("en", "") for s in (unit.get("target_sentences") or []) + (unit.get("key_expressions") or [])]
            pattern_examples = []
            for pat in over.get("patterns", []):
                pattern_examples += sentences_of(pat.get("example", ""))
            unit_word_names = [bare(v.get("en", "")) for v in unit.get("vocabulary") or []]
            for entry in unit.get("vocabulary") or []:
                w = bare(entry.get("en", ""))
                existing = next((words[f] for f in (w, w[:-1], w + "s") if f in words), None)
                if existing and existing.get("example"):
                    continue
                source, example = "", ""
                if (key, w) in OVERRIDES:
                    example, source = OVERRIDES[(key, w)], "manual override"
                if not example:
                    example = pick(local, w); source = "unit sentences" if example else ""
                if not example:
                    example = pick(pattern_examples, w); source = "pattern example" if example else ""
                if not example:
                    example = pick(all_sentences, w); source = "other unit sentences" if example else ""
                if not example:
                    # 換字：找一句含同單元其他字的句型例句
                    for sent in pattern_examples:
                        other = next((o for o in unit_word_names if o != w and contains_word(sent, o)), None)
                        if other:
                            example = swap_word(sent, other, w)
                            source = "swapped from '%s'" % sent
                            break
                if not example:
                    left.append((key, w))
                    continue
                target = existing if existing is not None else words.setdefault(w, OrderedDict())
                target["example"] = example
                filled.append((key, w, example, source))

    print("補上 %d 個例句；還缺 %d 個" % (len(filled), len(left)))
    for key, w, ex, src in filled:
        print("  %-12s %-16s %-40s ← %s" % (key, w, ex, src))
    for key, w in left:
        print("  [!] 沒找到：%s %s" % (key, w))
    if dry:
        print("(dry-run，沒有寫入)")
        return
    io.open(OVERLAY, "w", encoding="utf-8", newline="\n").write(
        json.dumps(overlay, ensure_ascii=False, indent=2) + "\n")
    print("已寫入", OVERLAY)


if __name__ == "__main__":
    main()

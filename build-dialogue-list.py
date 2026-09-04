# -*- coding: utf-8 -*-
"""列出所有「句型練習」需要的對話漫畫圖，寫成 dialogues.json 給 Gogo English 專案生圖。

一張圖 = 一個句型 × 一個代換字（沒有代換格的句型一張）。
畫面：左邊 Gogo 開口問（泡泡裡就是 ask 那句），右邊小朋友的泡泡空白，
物品／動作／人物畫在畫面裡，讓孩子看圖就知道該說哪句。

    python build-dialogue-list.py

輸出：../Gogo English/圖片提示詞/dialogues.json（格式比照 scenes.json，鍵是 b1_u03）
"""
import io
import json
import os
import re
import sys
from collections import OrderedDict

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "Gogo English", "圖片提示詞", "dialogues.json")

SHE = {"mother", "sister", "grandmother", "aunt", "girl"}
HE = {"father", "brother", "grandfather", "uncle", "boy", "friend"}
PLURAL_WORDS = {"glasses", "socks", "pants", "scissors", "shoes", "shorts"}
NUM_WORD = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
            "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
            "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
            "nineteen": 19, "twenty": 20}


def bare(s):
    # 去掉詞性註記；P.E. 這種結尾的句點也拿掉，不然句子會變成 "I like P.E.."
    return re.sub(r"\([^)]*\)", "", s or "").strip().rstrip(".")


def slug(s):
    s = s.lower().replace("'", "").replace(".", "").replace("-", "_")
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_") or "x"


def art(w):
    return "an" if w[:1].lower() in "aeiou" else "a"


def is_plural(word):
    return bool(word.get("plural")) or bare(word["english"]).lower() in PLURAL_WORDS


def pron(w):
    return "she" if w in SHE else "he"


# 每個句型：word -> dict(ask, answer, zh, hint)。hint = 畫面裡一定要看得到的東西。
# 沒有代換格的句型 word 是 None。
def T(ask, answer, zh, hint):
    return {"ask": ask, "answer": answer, "zh": zh, "hint": hint}


def where_b2(word):
    w = bare(word["english"]).lower()
    spot = {"skirt": "on the bed", "jacket": "in the box",
            "socks": "under the pillow", "pants": "between the boxes"}.get(w, "on the table")
    zh_spot = {"on the bed": "床上", "in the box": "箱子裡", "under the pillow": "枕頭下",
               "between the boxes": "兩個箱子中間", "on the table": "桌上"}[spot]
    if is_plural(word):
        return T("Where are my %s?" % w, "They're %s." % spot,
                 "我的%s在哪裡？在%s。" % (word["chinese"], zh_spot),
                 "a child's bedroom; the %s are clearly %s, both fully visible" % (w, spot))
    return T("Where's my %s?" % w, "It's %s." % spot,
             "我的%s在哪裡？在%s。" % (word["chinese"], zh_spot),
             "a child's bedroom; the %s is clearly %s, both fully visible" % (w, spot))


def where_b3(word):
    w = bare(word["english"]).lower()
    spot = {"wallet": "behind the sofa", "glasses": "in front of the bookcase"}[w]
    zh_spot = {"behind the sofa": "沙發後面", "in front of the bookcase": "書櫃前面"}[spot]
    if is_plural(word):
        return T("Where are my %s?" % w, "They're %s." % spot,
                 "我的%s在哪裡？在%s。" % (word["chinese"], zh_spot),
                 "a living room; the pair of eyeglasses lies on the floor directly %s, "
                 "both fully visible" % spot)
    return T("Where's my %s?" % w, "It's %s." % spot,
             "我的%s在哪裡？在%s。" % (word["chinese"], zh_spot),
             "a living room; the brown wallet peeks out from %s, both fully visible" % spot)


def whos(word):
    w = bare(word["english"]).lower()
    p = pron(w)
    P = p.capitalize()
    return T("Who's %s?" % p, "%s's my %s." % (P, w),
             "%s是誰？%s是我的%s。" % ("她" if p == "she" else "他", "她" if p == "she" else "他", word["chinese"]),
             "Gogo points at the child's %s standing right next to the child; the %s is a "
             "clearly recognizable %s figure (age and look obvious at a glance)"
             % (w, w, w))


def doing(word, who):
    w = bare(word["english"]).lower()
    if who == "they":
        return T("What are they doing?", "They're %s." % w,
                 "他們在做什麼？他們正在%s。" % word["chinese"],
                 "two other children in the background are clearly %s" % w)
    return T("What's %s doing?" % who, "%s's %s." % (who.capitalize(), w),
             "%s在做什麼？%s正在%s。" % ("她" if who == "she" else "他",
                                         "她" if who == "she" else "他", word["chinese"]),
             "a %s in the background is clearly %s" % ("girl" if who == "she" else "boy", w))


TEMPLATES = {
    "What's your name? / I'm [Name].": lambda w: T(
        "What's your name?", "I'm Tony.", "你叫什麼名字？我叫 Tony。",
        "Gogo and the child meeting for the first time in a park, both waving hello"),
    "Nice to meet you.": lambda w: T(
        "Nice to meet you.", "Nice to meet you, too.", "很高興認識你。我也很高興認識你。",
        "Gogo and the child shaking hands and smiling"),
    "What's this? / It's a/an [object].": lambda w: T(
        "What's this?", "It's %s %s." % (art(bare(w["english"])), bare(w["english"])),
        "這是什麼？這是%s。" % w["chinese"],
        "Gogo is holding up or pointing at one %s right in front of them, large and clear"
        % bare(w["english"])),
    "Can you [action]? / Yes, I can. / No, I can't.": lambda w: (
        T("Can you fly?", "No, I can't.", "你會飛嗎？不會，我不會。",
          "the child flaps both arms but stays on the ground, looking up at a bird flying "
          "in the sky") if bare(w["english"]).lower() == "fly" else
        T("Can you %s?" % bare(w["english"]), "Yes, I can.",
          "你會%s嗎？會，我會。" % w["chinese"],
          "the child is happily %sing (clearly performing the action %s), thumbs up"
          % (bare(w["english"]), bare(w["english"])))),
    "Who's she/he? / She's/He's my [family member].": whos,
    "Who's she? / She's my [relationship].": whos,
    "What's his/her name? / His/Her name's [Name].": lambda w: T(
        "What's her name?", "Her name's Jenny.", "她叫什麼名字？她叫 Jenny。",
        "Gogo points at a girl standing a little further away, waving"),
    "Is this a/an [animal]? / Yes, it is. / No, it isn't.": lambda w: T(
        "Is this %s %s?" % (art(bare(w["english"])), bare(w["english"])), "Yes, it is.",
        "這是%s嗎？是，它是。" % w["chinese"],
        "one friendly %s sits right in front of Gogo and the child, whole body visible"
        % bare(w["english"])),
    "What color is this? / It's [color].": lambda w: T(
        "What color is this?", "It's %s." % bare(w["english"]),
        "這是什麼顏色？是%s。" % w["chinese"],
        "Gogo holds up one big solid %s balloon; nothing else in the picture is %s"
        % (bare(w["english"]), bare(w["english"]))),
    "How old are you/is [someone]? / I'm [age]. / He's/She's [age].": lambda w: T(
        "How old are you?", "I'm seven.", "你幾歲？我七歲。",
        "a birthday cake with exactly seven lit candles on a table between them"),
    "What do you like? / I like [food].": lambda w: T(
        "What do you like?", "I like %s." % bare(w["english"]),
        "你喜歡什麼？我喜歡%s。" % w["chinese"],
        "the child is holding %s and looking delighted" % bare(w["english"])),
    "What's this? / It's a...": lambda w: T(
        "What's this?", "It's %s %s." % (art(bare(w["english"])), bare(w["english"])),
        "這是什麼？這是%s。" % w["chinese"],
        "Gogo is holding up or pointing at one %s right in front of them, large and clear"
        % bare(w["english"])),
    "What do you like? / I like...": lambda w: T(
        "What do you like?", "I like %s." % bare(w["english"]),
        "你喜歡什麼？我喜歡%s。" % w["chinese"],
        "the child is holding %s and looking delighted" % bare(w["english"])),
    "Subject + be + adjective.": lambda w: T(
        "Look at them!", "They're %s." % bare(w["english"]),
        "你看他們！他們很%s。" % w["chinese"],
        "Gogo points at two things or two people in the background that are unmistakably "
        "%s (the quality must be obvious at a glance)" % bare(w["english"])),
    "Do you like...? / Yes, I do. (No, I don't.)": lambda w: T(
        "Do you like %s?" % bare(w["english"]), "Yes, I do.",
        "你喜歡%s嗎？喜歡，我喜歡。" % w["chinese"],
        "the child is holding the equipment for %s" % bare(w["english"])),
    "What's that? / It's a...": lambda w: T(
        "What's that?", "It's %s %s." % (art(bare(w["english"])), bare(w["english"])),
        "那是什麼？那是%s。" % w["chinese"],
        "Gogo points far across the room at one %s on the other side of the picture"
        % bare(w["english"])),
    "What's that? / It's a [noun].": lambda w: T(
        "What's that?", "It's %s %s." % (art(bare(w["english"])), bare(w["english"])),
        "那是什麼？那是%s。" % w["chinese"],
        "Gogo points far across the room at one %s on the other side of the picture"
        % bare(w["english"])),
    "Is that a...? / Yes, it is. (No, it isn't.)": lambda w: T(
        "Is that %s %s?" % (art(bare(w["english"])), bare(w["english"])), "Yes, it is.",
        "那是%s嗎？是，它是。" % w["chinese"],
        "Gogo points far across the room at one %s on the other side of the picture"
        % bare(w["english"])),
    "What are these? / They're...": lambda w: T(
        "What are these?", "They're %s." % bare(w["english"]),
        "這些是什麼？它們是%s。" % w["chinese"],
        "Gogo holds a basket full of %s right in front of them" % bare(w["english"])),
    "Are these...? / Yes, they are. (No, they aren't.)": lambda w: T(
        "Are these %s?" % bare(w["english"]), "Yes, they are.",
        "這些是%s嗎？是，它們是。" % w["chinese"],
        "Gogo holds a basket full of %s right in front of them" % bare(w["english"])),
    "Where's my [singular]? / It's [prep.] the...": where_b2,
    "Where are my [plural]? / They're [prep.] the...": where_b2,
    "Where's my [item]? / It's [preposition] the [furniture].": where_b3,
    "Where are my [items]? / They're [preposition] the [furniture].": where_b3,
    "What time is it? / It's... o'clock.": lambda w: T(
        "What time is it?", "It's %s." % bare(w["english"]),
        "現在幾點？現在%s。" % w["chinese"],
        "a big round wall clock behind them clearly showing %d:00 (hour hand on %d, minute "
        "hand straight up on 12)" % (NUM_WORD[bare(w["english"]).split()[0]],
                                     NUM_WORD[bare(w["english"]).split()[0]])),
    "Is it... o'clock? / Yes, it is. (No, it isn't.)": lambda w: T(
        "Is it %s?" % bare(w["english"]), "Yes, it is.",
        "現在是%s嗎？是。" % w["chinese"],
        "a big round wall clock behind them clearly showing %d:00 (hour hand on %d, minute "
        "hand straight up on 12)" % (NUM_WORD[bare(w["english"]).split()[0]],
                                     NUM_WORD[bare(w["english"]).split()[0]])),
    "How many... are there? / There are...": lambda w: T(
        "How many apples are there?", "There are %s." % bare(w["english"]),
        "有幾個蘋果？有%s個。" % w["chinese"],
        "exactly %d red apples laid out in neat rows on a table between them, easy to count"
        % NUM_WORD[bare(w["english"]).lower()]),
    "Do you have...? / Yes, we do. (No, we don't.)": lambda w: T(
        "Do you have %s?" % (bare(w["english"]) if is_plural(w)
                             else "%s %s" % (art(bare(w["english"])), bare(w["english"]))),
        "Yes, we do.", "你們有%s嗎？有，我們有。" % w["chinese"],
        "the child and a friend are holding %s" % bare(w["english"])),
    "Does she/he have...? / Yes, she/he does. (No, she/he doesn't.)": lambda w: T(
        "Does she have %s?" % (bare(w["english"]) if is_plural(w)
                               else "%s %s" % (art(bare(w["english"])), bare(w["english"]))),
        "Yes, she does.", "她有%s嗎？有，她有。" % w["chinese"],
        "Gogo points at a girl in the background who is holding %s" % bare(w["english"])),
    "Are you [adjective]? / Yes, I am. (No, I'm not.)": lambda w: T(
        "Are you %s?" % bare(w["english"]), "Yes, I am.",
        "你%s嗎？是，我是。" % w["chinese"],
        "the child clearly looks %s (make the quality obvious at a glance)" % bare(w["english"])),
    "What day is it today? / It's [Day].": lambda w: T(
        "What day is it today?", "It's %s." % bare(w["english"]),
        "今天星期幾？今天%s。" % w["chinese"],
        "a wall calendar page behind them showing the single word %s in large clear letters "
        "(this word is allowed in the picture)" % bare(w["english"])),
    "What do you do on [Day]? / I [action] on [Day].": lambda w: T(
        "What do you do on Sunday?", "I play soccer on Sunday.",
        "你星期天做什麼？我星期天踢足球。",
        "the child is holding a soccer ball; a small calendar on the wall shows the word "
        "Sunday (this word is allowed in the picture)"),
    "Can I have a/an [noun], please? / Sure. Here you are.": lambda w: T(
        "Can I have %s %s, please?" % (art(bare(w["english"])), bare(w["english"])),
        "Sure. Here you are.", "請問我可以拿%s嗎？當然，給你。" % w["chinese"],
        "the child is holding out one %s toward Gogo" % bare(w["english"])),
    "Can I borrow your [noun]? / No. Sorry.": lambda w: T(
        "Can I borrow your %s?" % bare(w["english"]), "No. Sorry.",
        "我可以借你的%s嗎？不行，抱歉。" % w["chinese"],
        "the child hugs their own %s and shakes their head apologetically" % bare(w["english"])),
    "Do you like [subject]? / Yes, I do. (No, I don't.)": lambda w: T(
        "Do you like %s?" % bare(w["english"]), "Yes, I do.",
        "你喜歡%s嗎？喜歡。" % w["chinese"],
        "a classroom; the child holds a textbook and props that clearly stand for the school "
        "subject %s" % bare(w["english"])),
    "What subjects do you like? / I like [subject 1] and [subject 2].": lambda w: T(
        "What subjects do you like?", "I like %s." % bare(w["english"]),
        "你喜歡哪些科目？我喜歡%s。" % w["chinese"],
        "a classroom; the child holds a textbook and props that clearly stand for the school "
        "subject %s" % bare(w["english"])),
    "Do you want [item]? / Yes, please. (No, thank you.)": lambda w: T(
        "Do you want %s %s?" % (art(bare(w["english"])), bare(w["english"])), "Yes, please.",
        "你想要%s嗎？要，請給我。" % w["chinese"],
        "Gogo is holding out one %s toward the child" % bare(w["english"])),
    "Does she/he want [item]? / Yes, she/he does. (No, she/he doesn't.)": lambda w: T(
        "Does she want %s %s?" % (art(bare(w["english"])), bare(w["english"])), "Yes, she does.",
        "她想要%s嗎？要，她要。" % w["chinese"],
        "a toy shop; a girl in the background gazes longingly at one %s on a shelf"
        % bare(w["english"])),
    "What do they want? / They want [item].": lambda w: T(
        "What do they want?", "They want %s %s." % (art(bare(w["english"])), bare(w["english"])),
        "他們想要什麼？他們想要%s。" % w["chinese"],
        "a toy shop; two children in the background both point eagerly at one %s on a shelf"
        % bare(w["english"])),
    "What's she/he doing? / She's/He's [action-ing].": lambda w: doing(w, "she"),
    "What are they doing? / They're [action-ing].": lambda w: doing(w, "they"),
    "Touch your [body part]! / Close (Open) your [body part]!": lambda w: T(
        "Touch your %s!" % bare(w["english"]), "(does the action)",
        "摸你的%s！（做動作）" % w["chinese"],
        "the child is touching their own %s with both hands; the child has NO speech bubble "
        "in this picture" % bare(w["english"])),
    "Whose [item] is this? / It's [possessive pronoun/noun's].": lambda w: T(
        "Whose %s is this?" % bare(w["english"]), "It's mine.",
        "這是誰的%s？是我的。" % w["chinese"],
        "Gogo holds up one %s; the child raises a hand happily" % bare(w["english"])),
}

# 這些句型不是「所有同 slot 的字」都合理，指定要畫的字
WORD_FILTER = {
    "Where's my [singular]? / It's [prep.] the...": lambda w: not is_plural(w),
    "Where are my [plural]? / They're [prep.] the...": is_plural,
    "Where's my [item]? / It's [preposition] the [furniture].":
        lambda w: bare(w["english"]).lower() == "wallet",
    "Where are my [items]? / They're [preposition] the [furniture].":
        lambda w: bare(w["english"]).lower() == "glasses",
}
# 這個句型在 units.json 是 action slot 但該單元沒有 action 字：畫一張通用圖
ALWAYS_ONE = {"What do you do on [Day]? / I [action] on [Day]."}

# 單元的字不是名詞、套不進句型的，整個句型改用手寫清單（word 仍是單元的字，方便對應）
CUSTOM = {
    # B3U3 的字是動詞：Can I + 動詞
    "Can I have a/an [noun], please? / Sure. Here you are.": [
        ("go", "Can I go to the park?", "Sure.", "我可以去公園嗎？當然。",
         "a park gate is visible behind them; the child points toward it"),
        ("use", "Can I use your pen?", "Sure.", "我可以用你的筆嗎？當然。",
         "the child is holding out a pen toward Gogo"),
        ("have", "Can I have a cookie, please?", "Sure. Here you are.",
         "請問我可以拿一片餅乾嗎？當然，給你。",
         "the child holds a plate of cookies and offers one to Gogo"),
        ("borrow", "Can I borrow your ruler?", "No. Sorry.", "我可以借你的尺嗎？不行，抱歉。",
         "the child hugs a wooden ruler and shakes their head apologetically"),
        ("buy", "Can I buy a toy car?", "Sure.", "我可以買一台玩具車嗎？當然。",
         "a toy shop; a toy car sits on the counter between them, the child is the shopkeeper"),
        ("watch", "Can I watch TV?", "No. Sorry.", "我可以看電視嗎？不行，抱歉。",
         "a living room with a television; the child shakes their head"),
        ("call", "Can I call Jenny?", "Sure.", "我可以打電話給 Jenny 嗎？當然。",
         "the child hands Gogo a telephone"),
        ("listen", "Can I listen to music?", "Sure.", "我可以聽音樂嗎？當然。",
         "the child holds out a pair of headphones; a few music notes float in the air"),
    ],
    "Can I borrow your [noun]? / No. Sorry.": [],
    # B3U11 的字是所有格代名詞：答句換字
    "Whose [item] is this? / It's [possessive pronoun/noun's].": [
        ("mine", "Whose bag is this?", "It's mine.", "這是誰的書包？是我的。",
         "Gogo holds up a red schoolbag; the child points at their own chest"),
        ("yours", "Whose ruler is this?", "It's yours.", "這是誰的尺？是你的。",
         "the child holds up a wooden ruler and points at Gogo; the ruler is Gogo's"),
        ("his", "Whose skateboard is this?", "It's his.", "這是誰的滑板？是他的。",
         "Gogo holds up a skateboard; the child points at a boy standing in the background"),
        ("hers", "Whose hat is this?", "It's hers.", "這是誰的帽子？是她的。",
         "Gogo holds up a sun hat; the child points at a girl standing in the background"),
        ("ours", "Whose ball is this?", "It's ours.", "這是誰的球？是我們的。",
         "Gogo holds up a soccer ball; the child and a friend beside the child both point at "
         "themselves"),
        ("theirs", "Whose kite is this?", "It's theirs.", "這是誰的風箏？是他們的。",
         "Gogo holds up a kite; the child points at two children in the background"),
        ("Jenny's", "Whose pencil case is this?", "It's Jenny's.", "這是誰的鉛筆盒？是 Jenny 的。",
         "Gogo holds up a pencil case; the child points at a girl in the background who is "
         "waving"),
        ("Gogo's", "Whose book is this?", "It's Gogo's.", "這是誰的書？是 Gogo 的。",
         "the child holds up a book and points at Gogo; Gogo looks pleased"),
    ],
}


def main():
    data = json.load(io.open(os.path.join(HERE, "units.json"), encoding="utf-8"))
    out = OrderedDict()
    out["_說明"] = ("每個單元的句型對話漫畫。ask＝左邊 Gogo 泡泡裡的英文（一字不差）；"
                   "answer＝右邊小朋友應該說的話（泡泡留空白，不要畫出來）；"
                   "hint＝畫面裡一定要看得到的東西。由 AI tutor/build-dialogue-list.py 產生。")
    missing, total = [], 0
    alt = 0
    for book in data["books"]:
        b = int(book["name"].split()[1])
        for unit in book["units"]:
            if unit["type"] != "unit":
                continue
            key = "b%d_u%02d" % (b, unit["num"])
            rows = []
            for pi, pat in enumerate(unit["patterns"], 1):
                tpl = TEMPLATES.get(pat["english"])
                if not tpl:
                    missing.append((key, pat["english"]))
                    continue
                if pat["english"] in CUSTOM:
                    zh_of = {bare(w["english"]): w["chinese"] for w in unit["words"]}
                    for word, ask, answer, zh, hint in CUSTOM[pat["english"]]:
                        rows.append(OrderedDict([
                            ("id", "%s_dlg%02d_%s" % (key, pi, slug(word))),
                            ("filename", "%s_dlg%02d_%s.png" % (key, pi, slug(word))),
                            ("pattern", pat["english"]),
                            ("word", word),
                            ("word_zh", zh_of.get(word, "")),
                            ("ask", ask), ("answer", answer), ("zh", zh), ("hint", hint),
                        ]))
                    continue
                slot = pat.get("slot")
                words = [w for w in unit["words"] if w.get("slot") == slot] if slot else []
                flt = WORD_FILTER.get(pat["english"])
                if flt:
                    words = [w for w in words if flt(w)]
                if pat["english"] in ALWAYS_ONE:
                    words = [None]
                elif slot and not words:
                    # 單元裡沒有這個 slot 的字（例如 B3U3 的 noun）：改用單元裡的名詞
                    words = [w for w in unit["words"]
                             if w.get("slot") not in ("other", "preposition", "adjective")]
                    print("[i] %s「%s」沒有 %s 字，改用：%s" % (
                        key, pat["english"], slot, [bare(w["english"]) for w in words]))
                if not words:
                    words = [None]
                for w in words:
                    d = tpl(w)
                    # What's she/he doing 交替畫男生女生
                    if pat["english"].startswith("What's she/he doing"):
                        alt += 1
                        if alt % 2 == 0:
                            d = doing(w, "he")
                    word = bare(w["english"]) if w else ""
                    rows.append(OrderedDict([
                        ("id", "%s_dlg%02d_%s" % (key, pi, slug(word) if word else "x")),
                        ("filename", "%s_dlg%02d_%s.png" % (key, pi, slug(word) if word else "x")),
                        ("pattern", pat["english"]),
                        ("word", word),
                        ("word_zh", w["chinese"] if w else ""),
                        ("ask", d["ask"]),
                        ("answer", d["answer"]),
                        ("zh", d["zh"]),
                        ("hint", d["hint"]),
                    ]))
            out[key] = rows
            total += len(rows)
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print("寫出", OUT, "共", total, "張")
    if missing:
        print("[!] 沒有模板的句型：")
        for m in missing:
            print("   ", m)


if __name__ == "__main__":
    main()

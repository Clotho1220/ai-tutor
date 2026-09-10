# -*- coding: utf-8 -*-
"""字母旁白試聽室：同一個字母錄幾種「音」的唸法，做成一頁讓人用耳朵挑。

我聽不到聲音，Scribe 轉文字又分不出「怪」——只有人耳能判。與其一輪一輪猜，
不如一次把候選都錄出來，你點著聽、告訴我要哪一個。

    python letter-audio-lab.py I,J,L
    → audio/letters/lab/<字母>_<編號>.mp3 + tests/letter-audio-lab.html

挑好之後跟我說「I 用 2、J 用 1」，我把那個寫法寫進 build-letters.py 的表、
重錄正式檔、跑 review。試聽用的檔不進正式流程。
"""
import html
import importlib.util
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LAB_DIR = os.path.join(HERE, "audio", "letters", "lab")
PAGE = os.path.join(HERE, "tests", "letter-audio-lab.html")


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), os.path.join(HERE, name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load("build-letters.py")
recorder = load("build-letter-audio.py")

# 每個字母的候選：只換中間那段「音」，字母名與例字照正式版
def candidates(head, word):
    ph = builder.phoneme
    name = ph(head, builder.LETTER_NAME[head]) if head in "AEIOU" else head
    vowel = {"A": "AE1", "E": "EH1", "I": "IH1", "O": "AA1", "U": "AH1"}
    arpa = {"B": "B", "C": "K", "D": "D", "F": "F", "G": "G", "H": "HH", "J": "JH", "K": "K",
            "L": "L", "M": "M", "N": "N", "P": "P", "Q": "K W", "R": "R", "S": "S", "T": "T",
            "V": "V", "W": "W", "X": "K S", "Y": "Y", "Z": "Z"}
    text_say = {"I": "ih", "A": "aa", "E": "eh", "O": "ah", "U": "uh"}
    options = []
    if head in vowel:
        options = [("音標 " + vowel[head], ph(head.lower(), vowel[head])),
                   ("文字 " + text_say[head], text_say[head]),
                   ("音標唸兩次", ph(head.lower(), vowel[head]) + " " + ph(head.lower(), vowel[head]))]
    else:
        spelled = builder.SOUND_SAY.get(head, head.lower() + "uh")
        options = [("音標＋輕 uh " + arpa[head] + " AH0", ph(head.lower(), arpa[head] + " AH0")),
                   ("文字 " + spelled, spelled),
                   ("純音標 " + arpa[head], ph(head.lower(), arpa[head]))]
    lines = []
    for label, sound in options:
        line = (" " + builder.PAUSE + " ").join([name, sound, word]) + "."
        lines.append((label, line))
    return lines


# 第二輪：flash_v2 的三種寫法都被打回票的字母，換引擎再試。
#   1  eleven_turbo_v2 ＋ Arpabet 音標（跟 flash 同一套標籤、不同模型）
#   2  eleven_v3 ＋ 原生 IPA（/æ/ 這種直接寫在斜線裡）
#   3  eleven_v3 ＋ 拉長的 IPA（/æː/）
# v3 不吃 <break>，用 ... 停頓；母音的字母名也用 IPA 寫，子音字母名直接寫字母。
ROUND2 = {
    "A": ("AE1", "æ", "/eɪ/"), "E": ("EH1", "ɛ", "/iː/"), "U": ("AH1", "ʌ", "/juː/"),
    "R": ("R", "ɹ", "R"), "S": ("S", "s", "S"), "X": ("K S", "ks", "X"), "Z": ("Z", "z", "Z"),
}


def candidates_round2(head, word_plain):
    ph = builder.phoneme
    arpa, ipa, v3name = ROUND2[head]
    name_v2 = ph(head, builder.LETTER_NAME[head]) if head in "AEIOU" else head
    v2 = (" " + builder.PAUSE + " ").join([name_v2, ph(head.lower(), arpa), word_plain]) + "."
    v3a = " ... ".join([v3name, "/%s/" % ipa, word_plain]) + "."
    v3b = " ... ".join([v3name, "/%sː/" % ipa, word_plain]) + "."
    return [("turbo_v2 音標 " + arpa, v2, "eleven_turbo_v2"),
            ("v3 原生 IPA /%s/" % ipa, v3a, "eleven_v3"),
            ("v3 拉長 IPA /%sː/" % ipa, v3b, "eleven_v3")]


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    round2 = "--round2" in argv
    argv = [a for a in argv if a != "--round2"]
    heads = [h.strip().upper() for h in (argv[0] if argv else "").split(",") if h.strip()]
    if not heads:
        sys.exit("用法：python letter-audio-lab.py I,J,L   或   python letter-audio-lab.py --round2 A,E,U")
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        sys.exit("請先設好環境變數 ELEVENLABS_API_KEY。")
    letters = builder.read_pairs()
    os.makedirs(LAB_DIR, exist_ok=True)

    sections = []
    for head in heads:
        name = head + head.lower()
        words = letters.get(name)
        if not words:
            print("沒有這個字母：", head)
            continue
        english = words[0][0]
        word = english[0].upper() + english[1:]
        if english.lower() in builder.WORD_SAY:
            word = builder.phoneme(word, builder.WORD_SAY[english.lower()])
        rows = []
        if round2:
            plain = english[0].upper() + english[1:]
            picks = [(label, line, model) for label, line, model in candidates_round2(head, plain)]
            suffix = "r2"
        else:
            picks = [(label, line, recorder.DEFAULT_MODEL) for label, line in candidates(head, word)]
            suffix = ""
        for index, (label, line, model) in enumerate(picks, 1):
            stem = "%s_%s%d" % (head, suffix, index)
            target = os.path.join(LAB_DIR, stem + ".mp3")
            audio = recorder.speak(line, recorder.DEFAULT_VOICE, model, key)
            with open(target, "wb") as handle:
                handle.write(audio)
            rows.append((index, label, line, "../audio/letters/lab/%s.mp3" % stem))
            print("  錄好 %s  %s" % (stem, label))
        sections.append((name, english, rows))

    parts = ['<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>字母旁白試聽室</title>',
             '<style>body{font-family:system-ui;margin:24px;max-width:760px}h2{margin-top:32px}',
             '.row{display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid #eee}',
             '.row b{width:3em}.row small{color:#777;flex:1}</style>',
             '<h1>字母旁白試聽室</h1><p>每個字母的候選只換中間那段「音」，字母名與例字跟正式版一樣。',
             '聽完跟我說「I 用 2、J 用 1」這樣就好。</p>']
    for name, english, rows in sections:
        parts.append("<h2>%s　（%s）</h2>" % (html.escape(name), html.escape(english)))
        for index, label, line, src in rows:
            parts.append('<div class="row"><b>%d</b><audio controls preload="none" src="%s"></audio>'
                         '<small>%s</small></div>' % (index, src, html.escape(label)))
    page = PAGE.replace("letter-audio-lab.html", "letter-audio-lab-round2.html") if round2 else PAGE
    io.open(page, "w", encoding="utf-8", newline="\n").write("\n".join(parts) + "\n")
    print("✅ 試聽頁：tests/%s" % os.path.basename(page))


if __name__ == "__main__":
    main(sys.argv[1:])

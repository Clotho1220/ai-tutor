# -*- coding: utf-8 -*-
"""把 audio/letters/ 的每一段旁白用 ElevenLabs Scribe 轉回文字，對一次「該唸的字有沒有唸出來」。

為什麼需要這支：錄音是用 TTS 產的，產完沒有人聽過。2026-09-10 兩輪實聽抓到
「字母唸兩次」「字母沒唸」「字母名被唸成它的音」——這些在檔案大小、長度上完全看不出來，
只有把聲音轉回文字才對得出來。這支就是那個「轉回文字對一次」。

它能抓到什麼：少唸、多唸、唸錯字、唸成別的單字。
它抓不到什麼：/eɪ/ 跟 /æ/ 這種同一個字母的「名」與「音」——轉文字大多都會寫成 A。
所以字母名改用 phoneme 標籤釘死（見 build-letters.py），這裡只負責守住其餘的錯。

    python review-letter-audio.py            # 全部檢查，印報告，寫 audio/letters/review.json
    python review-letter-audio.py --only A,E # 只查這幾個字母

需要環境變數 ELEVENLABS_API_KEY（跟錄音同一把）。
"""

import argparse
import io
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
LETTERS = os.path.join(HERE, "letters.json")
AUDIO_DIR = os.path.join(HERE, "audio")
REPORT = os.path.join(AUDIO_DIR, "letters", "review.json")
API = "https://api.elevenlabs.io/v1/speech-to-text"


def transcribe(path, key):
    boundary = "----review" + uuid.uuid4().hex
    with open(path, "rb") as handle:
        audio = handle.read()
    fields = [("model_id", "scribe_v1"), ("language_code", "eng"),
              ("timestamps_granularity", "word"), ("tag_audio_events", "false")]
    body = b""
    for name, value in fields:
        body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                 % (boundary, name, value)).encode("utf-8")
    body += ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
             "Content-Type: audio/mpeg\r\n\r\n" % (boundary, os.path.basename(path))).encode("utf-8")
    body += audio + ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    request = urllib.request.Request(
        API, data=body,
        headers={"xi-api-key": key,
                 "Content-Type": "multipart/form-data; boundary=%s" % boundary})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def norm(text):
    return re.sub(r"[^a-z0-9 ]+", " ", str(text or "").lower()).split()


def judge(letter_head, english, transcript):
    """該聽到：字母名一次、例字一次。多的、少的、錯的都列出來。"""
    heard = norm(transcript)
    problems = []
    word_tokens = norm(english)
    # 例字有沒有出現（x-ray → x ray，允許被拆開或黏在一起）
    joined = " ".join(heard)
    if " ".join(word_tokens) not in joined and "".join(word_tokens) not in joined.replace(" ", ""):
        problems.append("沒聽到例字「%s」" % english)
    # 字母名：轉文字通常寫成單獨一個大寫字母（A / B），或字母的字（bee / see 也算）
    name_forms = {letter_head.lower()}
    name_forms |= {"bee": "b", "see": "c", "dee": "d", "gee": "g", "jay": "j", "kay": "k",
                   "el": "l", "em": "m", "en": "n", "oh": "o", "pee": "p", "cue": "q",
                   "queue": "q", "are": "r", "ess": "s", "tea": "t", "tee": "t", "you": "u",
                   "vee": "v", "ex": "x", "why": "y", "zee": "z", "zed": "z", "eye": "i",
                   "ay": "a", "aitch": "h", "ef": "f", "ee": "e"}.keys()
    letter_hits = [t for t in heard if t == letter_head.lower()
                   or (t in name_forms and t != letter_head.lower())]
    if not letter_hits:
        problems.append("沒聽到字母名「%s」" % letter_head)
    # 唸了四次以上字母＝多唸。名＋音各一次是正常的，轉文字兩個都可能寫成 J，
    # 例字開頭那個字母偶爾還會被拆成第三個（J-j-j-jellyfish），三次以內不算
    if heard.count(letter_head.lower()) >= 4:
        problems.append("字母「%s」出現 %d 次，多唸了" % (letter_head, heard.count(letter_head.lower())))
    # 整段太長＝夾了別的字
    if len(heard) > len(word_tokens) + 4:
        problems.append("聽到多餘的字：%s" % " ".join(heard))
    return problems


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key:
        sys.exit("請先設好環境變數 ELEVENLABS_API_KEY。")
    with io.open(LETTERS, encoding="utf-8") as handle:
        rows = json.load(handle)["letters"]
    wanted = {p.strip().upper() for p in args.only.split(",") if p.strip()}

    report, bad = [], 0
    for row in rows:
        head = row["letter"][0]
        if wanted and head not in wanted:
            continue
        for word in row["words"]:
            path = os.path.join(AUDIO_DIR, word["audio"].replace("/", os.sep))
            if not os.path.isfile(path):
                report.append({"file": word["audio"], "problems": ["沒有錄音檔"]})
                bad += 1
                continue
            try:
                result = transcribe(path, key)
            except urllib.error.HTTPError as error:
                sys.exit("Scribe 回應 %s：%s" % (error.code, error.read().decode("utf-8", "replace")[:300]))
            text = result.get("text", "")
            problems = judge(head, word["english"], text)
            report.append({"file": word["audio"], "expect": word["expect"],
                           "heard": text, "problems": problems})
            mark = "❌" if problems else "✅"
            print("%s %-22s 聽到：%-32s %s" % (mark, os.path.basename(path), text.strip(),
                                            "；".join(problems)))
            bad += 1 if problems else 0

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    io.open(REPORT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    print("\n%s：%d 段，有問題 %d 段。報告在 %s"
          % ("⚠️" if bad else "✅", len(report), bad, os.path.relpath(REPORT, HERE)))
    print("（轉文字分不出同一個字母的「名」與「音」，那部分靠 phoneme 標籤釘死；這裡守的是少唸、多唸、唸錯。）")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

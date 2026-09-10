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


def judge_segment(role, head, english, transcript):
    """字母名那段要聽到字母；單字那段要聽到例字；音那段轉文字判不了，只確認不是空的。"""
    heard = norm(transcript)
    if role == "name":
        names = {"bee": "b", "see": "c", "dee": "d", "gee": "g", "jay": "j", "kay": "k", "el": "l",
                 "em": "m", "en": "n", "oh": "o", "pee": "p", "cue": "q", "queue": "q", "are": "r",
                 "ess": "s", "tea": "t", "tee": "t", "you": "u", "vee": "v", "ex": "x", "why": "y",
                 "zee": "z", "zed": "z", "eye": "i", "ay": "a", "aitch": "h", "ef": "f", "ee": "e"}
        hit = any(t == head.lower() or names.get(t) == head.lower() for t in heard)
        return [] if hit else ["沒聽到字母名「%s」（聽到：%s）" % (head, transcript.strip() or "空的")]
    if role == "word":
        tokens = norm(english)
        joined = " ".join(heard)
        # 同音字：轉文字寫成哪個都算（ant→aunt、sun→son、lion→leon）
        homophones = {"ant": ["aunt"], "sun": ["son"], "lion": ["leon", "lyon"], "bear": ["bare"],
                      "rice": ["rise"], "witch": ["which"], "ox": ["ocks"]}
        forms = [" ".join(tokens), "".join(tokens)] + homophones.get(english.lower(), [])
        ok = any(f in joined or f in joined.replace(" ", "") for f in forms)
        return [] if ok else ["沒聽到例字「%s」（聽到：%s）" % (english, transcript.strip() or "空的")]
    return [] if heard else ["音那段是空的"]


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

    report, bad, seen = [], 0, set()
    for row in rows:
        head = row["letter"][0]
        if wanted and head not in wanted:
            continue
        for word in row["words"]:
            for seg in word["segments"]:
                if seg["file"] in seen:
                    continue
                seen.add(seg["file"])
                path = os.path.join(AUDIO_DIR, seg["file"].replace("/", os.sep))
                if not os.path.isfile(path):
                    report.append({"file": seg["file"], "problems": ["沒有錄音檔"]})
                    bad += 1
                    print("❌ %-22s 沒有錄音檔" % os.path.basename(path))
                    continue
                try:
                    result = transcribe(path, key)
                except urllib.error.HTTPError as error:
                    sys.exit("Scribe 回應 %s：%s" % (error.code, error.read().decode("utf-8", "replace")[:300]))
                text = result.get("text", "")
                problems = judge_segment(seg["role"], head, word["english"], text)
                report.append({"file": seg["file"], "role": seg["role"], "model": seg["model"],
                               "heard": text, "problems": problems})
                mark = "❌" if problems else "✅"
                print("%s %-22s %-5s 聽到：%-22s %s" % (mark, os.path.basename(path), seg["role"],
                                                      text.strip(), "；".join(problems)))
                bad += 1 if problems else 0

    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    io.open(REPORT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(report, ensure_ascii=False, indent=1) + "\n")
    print("\n%s：%d 段，有問題 %d 段。報告在 %s"
          % ("⚠️" if bad else "✅", len(report), bad, os.path.relpath(REPORT, HERE)))
    print("（「音」那段轉文字判不了，只確認不是空的；字母名與例字才有對。）")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

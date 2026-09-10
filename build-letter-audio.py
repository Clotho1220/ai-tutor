# -*- coding: utf-8 -*-
"""用 ElevenLabs 把 52 張字母卡的旁白錄成 mp3，放進 audio/letters/。

字母單元是「影片播放」：卡片＋旁白，程式照順序播，中間留一段安靜讓孩子跟著唸。
旁白預錄的好處是上課完全不用連線、沒有延遲、每次唸的一模一樣，
而且不會像即時模型那樣自己加話（2026-09-10 實測就是被這件事拖垮的）。

要唸的那一句寫在 letters.json 的 `say`（由 build-letters.py 產生）：
    <phoneme ...ph="EY1">A</phoneme> <break/> <phoneme ...ph="AE1">a</phoneme> <break/> Apple.
    每張卡都一樣：字母名 → 音 → 單字。字母名與母音的音用 phoneme 標籤釘死，
    不再讓 TTS 猜（2026-09-10 第二輪實聽：A、E 的字母名被唸成了它的音）。
    錄完用 review-letter-audio.py 把每一段轉回文字對一次。

用法（金鑰只留在你自己的環境變數裡，不要寫進檔案）：

    setx ELEVENLABS_API_KEY "你的金鑰"        # Windows，設一次就好（要重開終端機）
    python build-letter-audio.py

    python build-letter-audio.py --voice <voice_id>   # 換聲音
    python build-letter-audio.py --only A,B,C         # 只重錄這幾個字母
    python build-letter-audio.py --force              # 全部重錄

錄完直接重新整理網頁就會用預錄的聲音；沒有 mp3 的卡片會退回瀏覽器內建語音。
覺得哪個音唸得怪，改 build-letters.py 的 SOUND_SAY、重跑 build-letters.py，
再用 --only 把那幾個字母補錄就好（語速在 speak() 的 voice_settings.speed）。
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LETTERS = os.path.join(HERE, "letters.json")
OUT_DIR = os.path.join(HERE, "audio", "letters")
API = "https://api.elevenlabs.io/v1/text-to-speech/%s"

# ElevenLabs 內建的英文聲音。清楚、語速穩，適合帶著小小孩唸。
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"          # Rachel
# 只有 flash_v2 支援 phoneme 標籤（字母名靠它才不會被猜成別的音）
DEFAULT_MODEL = "eleven_flash_v2"


def speak(text, voice, model, key):
    body = json.dumps({
        "text": text,
        "model_id": model,
        # stability 高一點：同一個音每次唸出來要一樣，不要有情緒起伏
        # speed 0.8：使用者實聽第一版覺得太快。這是給小小孩跟著唸的，寧可慢。
        "voice_settings": {"stability": 0.75, "similarity_boost": 0.75, "speed": 0.8},
    }).encode("utf-8")
    request = urllib.request.Request(
        API % voice, data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json",
                 "Accept": "audio/mpeg"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_VOICE))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--only", default="", help="只錄這幾個字母，逗號分隔（A,B,C）")
    parser.add_argument("--force", action="store_true", help="已存在的也重錄")
    parser.add_argument("--dry-run", action="store_true", help="只列出要錄什麼，不呼叫 API")
    args = parser.parse_args()

    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not key and not args.dry_run:
        sys.exit("請先設好環境變數 ELEVENLABS_API_KEY（金鑰不要寫進專案檔案）。\n"
                 "想先看看會錄哪些句子，可以加 --dry-run。")

    with io.open(LETTERS, encoding="utf-8") as handle:
        rows = json.load(handle)["letters"]

    wanted = {part.strip().upper() for part in args.only.split(",") if part.strip()}
    os.makedirs(OUT_DIR, exist_ok=True)

    todo = []
    for row in rows:
        head = row["letter"][0]
        if wanted and head not in wanted:
            continue
        for word in row["words"]:
            target = os.path.join(HERE, "audio", word["audio"].replace("/", os.sep))
            if os.path.exists(target) and not args.force:
                continue
            todo.append((word["say"], target))

    if not todo:
        print("✅ 每一張卡都已經有錄音了（要重錄請加 --force）。")
        return

    print("要錄 %d 段：" % len(todo))
    for text, target in todo[:5]:
        print("   %-24s %s" % (os.path.basename(target), text))
    if len(todo) > 5:
        print("   ...")
    if args.dry_run:
        print("（--dry-run，沒有真的呼叫 API）")
        return

    done = 0
    for text, target in todo:
        try:
            audio = speak(text, args.voice, args.model, key)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:300]
            sys.exit("ElevenLabs 回應 %s：%s\n已錄好 %d 段，修好之後再跑一次會從中斷的地方接下去。"
                     % (error.code, detail, done))
        except urllib.error.URLError as error:
            sys.exit("連不上 ElevenLabs：%s\n已錄好 %d 段。" % (error.reason, done))
        with open(target, "wb") as handle:
            handle.write(audio)
        done += 1
        if done % 10 == 0:
            print("  ... 已錄 %d/%d" % (done, len(todo)), flush=True)
        time.sleep(0.2)          # 別把免費額度的速率限制打爆

    total = sum(os.path.getsize(os.path.join(OUT_DIR, name))
                for name in os.listdir(OUT_DIR) if name.endswith(".mp3"))
    print("✅ audio/letters/：新錄 %d 段，合計 %.1f MB" % (done, total / 1024 / 1024))
    print("   重新整理網頁就會用預錄的聲音。")


if __name__ == "__main__":
    main()

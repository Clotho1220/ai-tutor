# -*- coding: utf-8 -*-
"""用 OpenAI 影像模型補畫缺的對話漫畫（v3.50，使用者 2026-09-14 決定「請 GPT 去生圖」）。

流程：
    py -3 build-dialogue-list.py            → 印出「還沒有圖」的 id
    py -3 build-dialogue-images.py <id>...  → 每張叫一次 API，PNG 放進 Gogo English 的母版資料夾
    py -3 build-images.py                   → 轉成 images/*.webp
    py -3 build-dialogue-list.py            → 網頁索引現在會收進這幾張

提示詞不自己寫：讀 Gogo English/圖片提示詞/prompts.json（由那邊的 build_prompts.py 產生，
跟其他 239 張同一套角色、構圖、泡泡規則），所以先在那個資料夾跑一次 py -3 build_prompts.py。

金鑰：OPENAI_API_KEY（使用者環境變數）。跟 ElevenLabs 一樣，現有 shell 可能讀不到：
    $env:OPENAI_API_KEY = [Environment]::GetEnvironmentVariable("OPENAI_API_KEY","User")
不會印出金鑰。每張約 1024×1024、quality medium；--dry-run 只列提示詞不花錢。
"""
import base64
import io
import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
GOGO = os.path.join(os.path.dirname(HERE), "Gogo English", "圖片提示詞")
PROMPTS = os.path.join(GOGO, "prompts.json")
MASTERS = os.path.join(GOGO, "圖片生成")
BOOK_DIR = {"1": "第1冊", "2": "第2冊", "3": "第3冊"}
MODEL = "gpt-image-1"


def generate(prompt, api_key):
    body = json.dumps({"model": MODEL, "prompt": prompt, "size": "1024x1024",
                       "quality": "medium", "n": 1}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations", data=body, method="POST",
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.load(resp)
    return base64.b64decode(payload["data"][0]["b64_json"])


def main(argv):
    dry = "--dry-run" in argv
    ids = [a for a in argv if not a.startswith("--")]
    if not ids:
        sys.exit("用法：py -3 build-dialogue-images.py <id> [<id> ...] [--dry-run]")
    if not os.path.isfile(PROMPTS):
        sys.exit("找不到 %s，先在 Gogo English/圖片提示詞 跑 py -3 build_prompts.py" % PROMPTS)
    items = {item["id"]: item for item in json.load(io.open(PROMPTS, encoding="utf-8"))["items"]}
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not dry and not api_key:
        sys.exit("沒有 OPENAI_API_KEY（使用者環境變數）。先設定再跑，或加 --dry-run 只看提示詞。")
    done, failed = [], []
    for image_id in ids:
        item = items.get(image_id)
        if not item:
            print("[!] prompts.json 裡沒有", image_id, "（先跑 build-dialogue-list.py 與 build_prompts.py）")
            failed.append(image_id)
            continue
        book = image_id[1]
        out_dir = os.path.join(MASTERS, BOOK_DIR.get(book, "第%s冊" % book))
        out_path = os.path.join(out_dir, image_id + ".png")
        print("==", image_id, "→", out_path)
        print(item["prompt"][:300] + "…")
        if dry:
            continue
        try:
            os.makedirs(out_dir, exist_ok=True)
            png = generate(item["prompt"], api_key)
            io.open(out_path, "wb").write(png)
            done.append(image_id)
            print("   ok", len(png), "bytes")
        except Exception as error:   # 照實回報，不放假圖
            failed.append(image_id)
            print("   失敗：", str(error)[:300])
    print("完成 %d 張、失敗 %d 張" % (len(done), len(failed)))
    if done:
        print("接著：py -3 build-images.py → py -3 build-dialogue-list.py")


if __name__ == "__main__":
    main(sys.argv[1:])

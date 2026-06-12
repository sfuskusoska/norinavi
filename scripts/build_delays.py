# 鉄道遅延情報のjson (https://tetsudo.rti-giken.jp/) を取得し、
# アプリが読む live/delays.json に変換する。遅延内容が変化したときだけ updated を進める。
import json
import sys
import time

src_path, out_path = sys.argv[1], sys.argv[2]

with open(src_path, encoding="utf-8") as f:
    feed = json.load(f)

delays = sorted(
    (
        {
            "name": d.get("name", ""),
            "company": d.get("company", ""),
            "since": d.get("lastupdate_gmt", 0),
        }
        for d in feed
        if d.get("name")
    ),
    key=lambda d: (d["company"], d["name"]),
)

try:
    with open(out_path, encoding="utf-8") as f:
        old = json.load(f)
except Exception:
    old = {}

out = {
    "updated": old.get("updated", 0),
    "source": "鉄道遅延情報のjson (https://tetsudo.rti-giken.jp/)",
    "delays": delays,
}
if old.get("delays") != delays:
    out["updated"] = int(time.time())

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

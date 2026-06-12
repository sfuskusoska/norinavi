# JR西日本「列車走行位置」公式データを取得し、収録JR路線の最大遅延分を
# live/delays.json に書き出す。遅延内容が変化したときだけ updated を進める。
import json
import sys
import time
import urllib.request

BASE = "https://www.train-guide.westjr.co.jp/api/v3/"
# 収録JR路線 → JR西日本APIのエンドポイント
LINES = [
    ("o_loop", "osakaloop"),     # 大阪環状線
    ("o_jrkk", "kobesanyo"),     # JR京都線・神戸線
    ("o_tozai", "gakkentoshi"),  # JR東西線・学研都市線
]

out_path = sys.argv[1] if len(sys.argv) > 1 else "live/delays.json"

delays = []
for line_id, api in LINES:
    try:
        req = urllib.request.Request(
            BASE + api + ".json",
            headers={"User-Agent": "norinavi-bot (https://github.com/sfuskusoska/norinavi)"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.load(r)
        trains = data.get("trains", []) or []
        mx = max((t.get("delayMinutes", 0) or 0) for t in trains) if trains else 0
        if mx > 0:
            delays.append({"lineId": line_id, "min": mx, "trains": len(trains)})
    except Exception as e:  # noqa: BLE001 取得失敗は無視して次へ
        print(f"{api}: {e}", file=sys.stderr)

delays.sort(key=lambda d: d["lineId"])

try:
    with open(out_path, encoding="utf-8") as f:
        old = json.load(f)
except Exception:  # noqa: BLE001
    old = {}

out = {
    "updated": old.get("updated", 0),
    "source": "JR西日本 列車走行位置 (https://www.train-guide.westjr.co.jp/)",
    "delays": delays,
}
if old.get("delays") != delays:
    out["updated"] = int(time.time())

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)

print(f"wrote {len(delays)} delayed line(s)")

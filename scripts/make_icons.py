# アプリアイコン(緑背景＋プラス模様＋白い輪郭の「ナビ」)を生成する。
# iOS/Android のホーム画面追加用に複数サイズのPNGを出力。
from PIL import Image, ImageDraw, ImageFont

BG = (76, 191, 106)        # 緑
WHITE = (255, 255, 255)
S = 512                    # マスター解像度
FONT = "C:/Windows/Fonts/YuGothB.ttc"  # 游ゴシック Bold

def make(text_frac=0.80):
    img = Image.new("RGB", (S, S), BG)

    # プラス模様(薄い白・8度回転)
    overlay = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    step = int(S * 0.168)
    arm = int(S * 0.034)
    t = int(S * 0.018)
    col = (255, 255, 255, 40)
    for gy in range(0, S * 2, step):
        for gx in range(0, S * 2, step):
            od.rectangle([gx - arm, gy - t, gx + arm, gy + t], fill=col)
            od.rectangle([gx - t, gy - arm, gx + t, gy + arm], fill=col)
    overlay = overlay.rotate(8, resample=Image.BICUBIC, center=(S, S))
    crop = overlay.crop((S // 2, S // 2, S // 2 + S, S // 2 + S))
    img.paste(crop, (0, 0), crop)

    # 文字「ナビ」: 背景色で塗り + 白い太輪郭 → 中抜きの白アウトライン
    draw = ImageDraw.Draw(img)
    text = "ナビ"
    fsize = 250
    font = ImageFont.truetype(FONT, fsize)
    # 幅が約78%に収まるようサイズ微調整
    while True:
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=14)
        w = bbox[2] - bbox[0]
        if w <= S * text_frac or fsize <= 110:
            break
        fsize -= 6
        font = ImageFont.truetype(FONT, fsize)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=14)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    cx = (S - w) / 2 - bbox[0]
    cy = (S - h) / 2 - bbox[1]
    draw.text((cx, cy), text, font=font, fill=BG,
              stroke_width=14, stroke_fill=WHITE)
    return img


# 通常版(フルブリード)
master = make(0.80)
for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "icon-180.png")]:
    master.resize((size, size), Image.LANCZOS).save(name)
    print("wrote", name)

# maskable版(余白多め・Androidの円形マスクでも文字が欠けない)
mask = make(0.60)
mask.resize((512, 512), Image.LANCZOS).save("icon-512-maskable.png")
print("wrote icon-512-maskable.png")

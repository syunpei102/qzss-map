from PIL import Image, ImageDraw

BG = (20, 22, 26, 255)      # パネルと同じダーク背景
RED = (255, 40, 0, 255)     # cross-marker/EEWと同じ赤

def make_icon(size, path, corner_radius_ratio=0.22):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = int(size * corner_radius_ratio)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    # 中央に✕マーカーを描く(震央マーカーと同じ意匠)
    cx, cy = size / 2, size / 2
    arm_len = size * 0.34
    arm_w = size * 0.09
    for angle_sign in (1, -1):
        import math
        dx = math.cos(math.radians(45 * angle_sign)) * arm_len
        dy = math.sin(math.radians(45 * angle_sign)) * arm_len
        x0, y0 = cx - dx, cy - dy
        x1, y1 = cx + dx, cy + dy
        draw.line([x0, y0, x1, y1], fill=RED, width=int(arm_w))
        # 角を丸く見せるため端に円を足す
        for x, y in ((x0, y0), (x1, y1)):
            r = arm_w / 2
            draw.ellipse([x - r, y - r, x + r, y + r], fill=RED)

    img.save(path)

make_icon(192, "public/icons/icon-192.png")
make_icon(512, "public/icons/icon-512.png")
make_icon(180, "public/icons/apple-touch-icon.png", corner_radius_ratio=0.0)  # iOSが自動で角丸にするため四角のまま
print("done")

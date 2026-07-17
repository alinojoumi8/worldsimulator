"""Build deterministic delivery formats from the selected GPT Image 2 masters."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "design" / "brand" / "source"
OUTPUT = ROOT / "apps" / "web" / "public" / "brand"
RESAMPLE = Image.Resampling.LANCZOS


def cover(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    return ImageOps.fit(source, size, method=RESAMPLE, centering=(0.5, 0.5))


def save_pair(image: Image.Image, stem: str) -> None:
    image.save(OUTPUT / f"{stem}.webp", "WEBP", quality=82, method=6)
    image.save(OUTPUT / f"{stem}.avif", "AVIF", quality=68)


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    windows_font = Path("C:/Windows/Fonts") / name
    return ImageFont.truetype(str(windows_font), size)


def build_social(hero: Image.Image, mark: Image.Image) -> Image.Image:
    social = cover(hero, (1200, 630)).convert("RGBA")
    veil = Image.new("RGBA", social.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(veil)
    draw.rounded_rectangle((52, 62, 668, 568), radius=28, fill=(243, 239, 230, 238))
    social = Image.alpha_composite(social, veil)

    mark_thumb = ImageOps.contain(mark.convert("RGBA"), (118, 118), method=RESAMPLE)
    social.alpha_composite(mark_thumb, (96, 104))
    draw = ImageDraw.Draw(social)
    draw.text((96, 250), "WorldTangle", font=font("georgiab.ttf", 67), fill="#17201F")
    draw.text(
        (100, 342),
        "Trace how one choice reshapes a world.",
        font=font("segoeui.ttf", 27),
        fill="#34413F",
    )
    draw.line((100, 420, 560, 420), fill="#B94B3B", width=5)
    draw.text(
        (100, 447),
        "A transparent, deterministic society simulator",
        font=font("segoeui.ttf", 19),
        fill="#5B6663",
    )
    return social.convert("RGB")


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    hero = Image.open(SOURCE / "riverbend-systems-master.png").convert("RGB")
    mark = Image.open(OUTPUT / "worldtangle-mark-raster.png").convert("RGBA")

    for size in ((1440, 810), (720, 405)):
        save_pair(cover(hero, size), f"riverbend-systems-{size[0]}")
    for size in ((960, 720), (480, 360)):
        save_pair(cover(hero, size), f"scenario-riverbend-{size[0]}")

    ImageOps.contain(mark, (512, 512), method=RESAMPLE).save(
        OUTPUT / "worldtangle-app-icon-512.png",
        optimize=True,
    )
    ImageOps.contain(mark, (32, 32), method=RESAMPLE).save(
        OUTPUT / "favicon-32.png",
        optimize=True,
    )
    build_social(hero, mark).save(
        OUTPUT / "worldtangle-social-1200x630.webp",
        "WEBP",
        quality=84,
        method=6,
    )

    for path in sorted(OUTPUT.iterdir()):
        if path.is_file():
            print(f"{path.relative_to(ROOT)}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()

# WorldTangle Brand Assets

WorldTangle uses a **causal tapestry** visual language: civic-editorial forms, warm paper, and restrained teal and copper paths that make cause and effect visible.

## Selected mark

Three GPT Image 2 explorations tested the same “Causal Knot” brief. Concept 03 was selected for its compact silhouette, legibility at small sizes, central W-shaped channel, and balanced asymmetry. The production SVG is a simplified code-native reconstruction; the selected generated source remains in `source/` for provenance.

Use the SVG mark in product UI. The generated raster is a fallback and source for the app icon. Never stretch, rotate, recolor individual strands, add effects, or place the mark on a low-contrast background.

## Accessibility

- Product logo: accessible name `WorldTangle causal knot` when it is the only brand identifier; otherwise treat the mark as decorative beside the visible wordmark.
- Riverbend hero alt: `Illustrated Riverbend civic and economic systems connected by causal threads.`
- Scenario-card crop is decorative when the card already names and describes Riverbend; use empty alt text.
- The palette is paper `#F3EFE6`, surface `#FFFDF8`, ink `#17201F`, river teal `#0B6B69`, and thread copper `#B94B3B`.

## Rebuilding exports

Run `python design/brand/build_assets.py` with Pillow installed. The script derives responsive AVIF/WebP crops, icons, and the social card from the selected masters without modifying them.

# gearbox — logo guidelines

## 1. The logo

**Idea:** the word shifts up halfway: "box" sits one tread higher than "gear", and the box symbol carries the same
two-step rise. One idea runs through the wordmark and the icon.

| Version | File | Use it for |
|---|---|---|
| Horizontal (primary) | `gearbox-horizontal.svg` | README header, website, slides |
| Stacked | `gearbox-stacked.svg` | Square spaces, stickers, title slides |
| Wordmark | `gearbox-wordmark.svg` | Where the symbol is already shown nearby |
| Symbol | `gearbox-symbol.svg` | Avatar, app icon, status line, anywhere from 24 px up |
| Symbol, small cut | `gearbox-symbol-small.svg` | 16–24 px: favicon, tabs (wider seam) |
| On dark | `*-on-dark.svg` | Dark mode, terminals (mint symbol, paper wordmark, wider seam) |

Ready-made exports live in `export/`: one-colour black, white and green lockups (`lockups/`), the symbol in every
variant with PNGs at 64/256/1024 px (`symbol/`), and the web icon set with `favicon.ico`, PNG icons, `site.webmanifest`
and `head-snippet.html` (`web/`). `source/build.py` regenerates the masters.

## 2. Clear space

Keep **one tread** clear on every side: the height difference between "gear" and "box" (30 units on the 256-unit-high
wordmark, about 12 % of the logo's height). The masters already include roughly this margin. For the symbol on its own,
keep a quarter of the box width clear.

## 3. Minimum size

| Version | Screen | Print |
|---|---|---|
| Horizontal | 120 px wide | 30 mm wide |
| Wordmark | 80 px wide | 20 mm wide |
| Symbol | 24 px (16 px with the small cut) | 6 mm |

## 4. Colour

| Name | HEX | RGB | CMYK (indicative) | Use |
|---|---|---|---|---|
| Gear green | `#0F7A55` | 15 122 85 | C88 M0 Y30 K52 | Symbol on light backgrounds |
| Mint | `#5BD6A0` | 91 214 160 | C57 M0 Y25 K16 | Symbol on dark backgrounds |
| Ink | `#16181D` | 22 24 29 | C24 M17 Y0 K89 | Wordmark, text, app-icon tile |
| Paper | `#F6F4EE` | 246 244 238 | C0 M1 Y3 K4 | Light background, wordmark on dark |
| Night | `#0E1013` | 14 16 19 | C26 M16 Y0 K93 | Dark background |

Contrast: green on white 5.3 : 1, mint on night 10.5 : 1, ink on paper 16.2 : 1, all above WCAG AA. The CMYK values are a
plain conversion; have the printer derive values from their own profile, and match a Pantone swatch on paper.

**Approved pairs:** full colour on white or paper · the on-dark version on ink or night · one-colour black on light ·
one-colour white on dark or on gear green · one-colour green on white.

## 5. Typography

The wordmark is drawn from circles and straight strokes; it is not a font, so never retype it. Next to the logo, set text
in the system UI font and code in the terminal's monospace font. No font licences are involved.

## 6. Don'ts

Don't put "box" back on the baseline, or lift any other letters · don't stretch, squash or rotate · don't recolour
outside the palette · don't add shadows, outlines, gradients or effects · don't close the seam of the box or mirror its
steps (they rise left to right) · don't change the size relation between symbol and wordmark in a lockup · don't place
the logo on busy backgrounds without a calm area.

## 7. Handover notes

- **Construction:** every master is filled outlines (no strokes, no live text, no masks), built on a grid with
  x-height 100, bowl radius 39 and stroke 22; the box is a 176-unit square with 36-unit corners and a 16-unit seam
  (18 on dark, 24 in the small cut, to counter irradiation and blur).
- **Overlapping shapes:** letter parts overlap instead of being merged into one outline. Screens and print render them
  correctly; for vinyl cutting or embroidery, run *Outline/Unite* in a vector editor first.
- **Tested:** 16–1024 px, one colour, reversed, light and dark backgrounds, mockups for README, terminal, website, app
  icon, sticker and social profile.
- **Open:** a trademark search (no clearance can be given here); a hand-tuned 16 px favicon on the pixel grid would
  sharpen the steps further.

# Working in this repo

The Markdown files in `docs/` are the source of truth. `docs/*.pdf` is generated
and gitignored — never edit it by hand.

After editing any `docs/*.md`:

```sh
python3 scripts/align-tables.py docs/*.md    # re-pad Markdown table columns (idempotent)
sh scripts/build-pdf.sh                      # render docs/*.md → docs/*.pdf (A4)
```

Tables use aligned column widths; run `align-tables.py` after changing any table
cell so widths stay consistent. Diagrams are hand-written SVGs (`docs/*.svg`)
referenced from the Markdown — edit the SVG, don't reintroduce ASCII art.

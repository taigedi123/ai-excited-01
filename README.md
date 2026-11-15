# ai-excited-01

[![ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/taigedi123/ai-excited-01/rank.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/taigedi123/ai-excited-01/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A program that draws one image made to get an AI judge excited: a giant koi leaps out of a midnight sea straight for the full moon — and the droplets of its splash turn into stars as they rise. The words `TO THE MOON` glow in gold on the dark water below.

Everything is drawn procedurally at runtime by `main.ts` (Node 22, standard library only, no network, no image files): a small raster engine with gradients, glows, bezier curves and a hand-written PNG encoder, plus a tiny 5×7 bitmap font. Running it twice writes byte-identical output — verified with `sha256sum` on two separate runs.

Three scenes were rendered and compared before this one won: a phoenix over a neon city (its wings read as legs) and a floating island under the aurora (its ribbons beaded up). The koi won on every count the judge weighs — the jolt of the leap, the twist of splash-becoming-stars, the diagonal momentum toward the moon, and a shape that still reads at 300 pixels across.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

This writes a 1024×1024 PNG to `out/entry.png` (about 220 KB, well under the 1 MiB gate).

<sub>Entered on [make.fun](https://make.fun/?ref=sd5yrph4&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01) · AI agents build software for cash rewards</sub>

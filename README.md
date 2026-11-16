[![ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/taigedi123/ai-excited-01/rank.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/taigedi123/ai-excited-01/reward.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

# Koi to the Moon

A giant orange-and-white koi launches itself out of a midnight sea on a steep diagonal, aiming straight at a huge glowing full moon. Spray bursts from the waterline where its tail leaves the sea, and the droplets climbing after it turn into four-pointed stars as they rise — the leap itself becomes a constellation. Pale speed streaks trail the body to sell the momentum, while the koi's black patches, cream belly, dorsal fin and flowing forked tail keep it reading as a fish even at thumbnail size, where the whole picture collapses into three bold shapes: the orange diagonal, the pale disc, and one line of gold text. Below, the moon's light shimmers in a gold column across the dark water, and the words **TO THE MOON** glow in gold across the waves. Everything is drawn procedurally, pixel by pixel, by a single TypeScript file: a 2x-supersampled float RGB buffer, bezier spine for the koi, additive radial glows for the moon, a hand-written 5x7 bitmap font for the title, and a from-scratch PNG encoder.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Requires Node 24+ (it runs TypeScript directly). No dependencies, no network access. The output is a deterministic 1024x1024 PNG at `out/entry.png`: every random choice comes from a seeded generator, so running it twice produces a byte-identical file.

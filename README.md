[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Avapage/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Avapage/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# Marked, but faster — a markdown-render-speed-02 entry

`parse.js` is a from-scratch Markdown engine that returns, for every input, byte-for-byte the HTML that marked 18.1.3's `marked.parse` returns with default options — verified 720/720 identical on the kit practice set, 720/720 on two freshly generated sets, and 0 diffs on 3,000 mutation-fuzz cases, with zero fallbacks to the vendored marked (kept in `vendor/marked/` purely as a defensive bailout). Speed comes from first-character dispatch in both lexers instead of trying every rule at every position, cached list regexes, and presence-gated emphasis scans: locally ~16% faster than the house baseline on the document cases, ~2x on the spec examples.

Run: `node main.ts` (reads /input/cases.json, writes /output/html.json).

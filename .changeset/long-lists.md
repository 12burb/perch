---
"@perch/ui": minor
"@perch/web": minor
---

Long lists stay fast, and CI keeps them that way. Home's channel list and the Git panel's changed
files now render only the rows you can see, through one shared `VirtualList` that tells a screen
reader how long the list really is. The sidebar's Channels, DMs and Bots sections show the thirty
most relevant rooms and a link to the rest. And `bun run perf` now audits every list in the app:
each one is virtualized, capped somewhere the check can read, or has a written reason — and a new
screen with a scrolling list fails the build until it says which.

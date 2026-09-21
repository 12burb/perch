---
"@perch/web": patch
---

The Preview tab no longer reloads its page every four seconds. The member ticket the ports poll
mints for the preview's own origin is taken once, when the pane opens a port, a path or a reload,
not on every poll; the page keeps its state and scroll position, and hot reloads are hot.

---
"@perch/web": patch
"@perch/api": patch
---

⌘K: leaving a file with a proposal unanswered now puts the original text back, as the docs always
said it did. Switching tabs, closing the tab, toggling a markdown preview, or pressing ⌘K again all
reject a standing proposal first — before this, only the bar went away and the agent's rewrite
stayed in the buffer with no way to review or undo it, and ⌘S would write it to disk. A reply that
arrives after you have moved to another file is dropped instead of landing there, and an inline
lane whose runner reconnected re-opens itself on the next ⌘K rather than failing forever.

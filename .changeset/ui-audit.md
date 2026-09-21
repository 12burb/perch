---
"@perch/web": patch
"@perch/ui": patch
---

The session pane keeps the right transcript when you switch sessions while a replay is still on its
way: the old session's rows no longer land in the new one, and the new session's replay is no longer
skipped. The channel transcript subscribes to its workspace topic once per channel instead of once
per render. The sidebar draws thirty projects and a link to the rest; the Projects table and the
members table draw a hundred rows and a page more per ask. Two placeholders and the markdown task
checkbox's label go through the message catalog, and a test keeps the next literal out.

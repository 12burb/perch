---
"@perch/api": patch
"@perch/events": patch
"@perch/web": patch
"@perch/ui": patch
---

WebSocket server at `/api/ws` (task 0.10, spec §7.2): subscribe/unsubscribe with per-topic
authorization, `resume { topic, after_seq }` from the replay buffer (or `resync` when it fell off),
presence per user per workspace with a `presence_snapshot` on subscribe, rate-limited typing on channel
topics, and the web client (`PerchSocket`, `usePresence`) showing who is online per workspace.

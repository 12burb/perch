---
"@perch/api": patch
---

Tracing resolves its tracer per call instead of keeping one from import time, and hands every span
whose parentage matters its parent rather than relying on an ambient context. Nothing changes for
an instance with tracing off; an instance with it on gets the same trace whether or not a context
manager is installed.

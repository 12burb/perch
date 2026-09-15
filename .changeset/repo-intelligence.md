---
"@perch/repo": minor
"@perch/api": minor
"@perch/web": minor
"@perch/gateway": minor
"@perch/db": minor
"@perch/ui": minor
---

Repo intelligence: Perch reads a project once and remembers it. **Index now** in Code mode's new
Codebase drawer walks the repository, cuts each file into symbol, window and Markdown-section chunks,
and writes them with a Postgres full-text index — and, when the workspace names a brain whose default
is `embedding`, with vectors as well. Typing `@codebase` in a session hands the agent the places your
question is about, each citing its file and lines, while the transcript keeps what you actually
typed. The same index answers in the panel, and in the new Code lane of the search box across every
project you can see, with each hit opening the file at the line. **Draft AGENTS.md** writes an
operating manual from what the repository shows and can save it into the project.

Embeddings stay optional on purpose: a Perch with no model credentials still has a working codebase
index and `@codebase` still cites the right file. A brain becomes the one Perch embeds with from the
new **Default for** control in Brains, which now names chat, code, and embedding rather than code
alone.

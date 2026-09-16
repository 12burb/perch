---
"@perch/api": minor
"@perch/inspector": minor
"@perch/ui": patch
"@perch/web": minor
---

Direct tweaks in the inspector. Select an element in the preview and the panel gives you its text
and its classes; typing in either changes the page as you type. **Write to source** then makes it
true in the repository, and shows you the diff.

There is no model anywhere near it: the element already carries where it was written, so the edit is
a pure function over that file and that position. It refuses whatever it cannot do exactly — a
`className` that is an expression, an element holding more than text, a position the file has moved
on from — with the reason, rather than guessing at a plausible edit.

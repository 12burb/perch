---
"@perch/cli": patch
---

`perch --version` (and `-v`, and `perch version`) says the version the binary was built as, instead
of "unknown command" — which is what the first thing anyone types at a freshly downloaded executable
used to get. `perch doctor` no longer reports the web app missing from a binary that has it embedded
and is serving it: it says how many files it is carrying.

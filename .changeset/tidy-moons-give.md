---
"@perch/api": minor
"@perch/db": minor
"@perch/gateway": minor
---

The model gateway at `/v1`. Point an OpenAI client at your Perch, use a virtual key where the API
key goes and a brain's name where the model goes, and the workspace's credential does the work
without ever leaving the server — streamed or not, with `GET /v1/models` and `POST /v1/embeddings`
beside it.

Keys are minted per workspace, person, bot or nobody-in-particular, shown exactly once, narrowed to
some brains if you like, given a budget over a day or a month, and revocable. Every call leaves a
row in the ledger and says what it cost in `Perch-Cost-Usd`; a key that has spent its budget is
refused with `402` before a provider is called. A brain can name others to fall back to when its
provider will not answer.

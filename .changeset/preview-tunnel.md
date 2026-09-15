---
"@perch/api": minor
"@perch/events": minor
"@perch/runner": minor
---

Previews work on a laptop too. A runner connected with `perch runner connect` is usually behind a
network the server cannot reach into, so its previews now travel back through the WebSocket the
runner already opened: Perch asks the runner to make the request, and the answer — or a whole
WebSocket, relayed frame for frame, HMR included — comes back on a stream. Nothing changes in the
Preview tab; a dev server on your laptop is simply watchable from your phone.

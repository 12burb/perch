---
"@perch/api": patch
"@perch/web": patch
"@perch/connect": patch
"@perch/db": patch
"@perch/ui": patch
"@perch/api-client": patch
---

A URL a member supplies — a connection's API base or MCP server, a brain's base URL, a push
endpoint — can no longer point the api at its own network: on a team instance it must be a public
address (push endpoints: public https), checked when it is entered (a 422 naming the field) and on
every request, redirects included, with a deadline and a size cap. Laptop mode, or the new
`PERCH_OUTBOUND_ALLOW_PRIVATE=on`, allows private addresses (ADR-0173).

Connections: an OAuth sign-in finishes only in a browser signed in as the person who started it,
on the provider it was started for, and is recorded as theirs; the workspace's registered app is
used only with a provider's own MCP server; MCP discovery ignores metadata for another resource or
issuer, or with plain-http endpoints; MCP sign-in connections now refresh, once at a time, without
being marked invalid by a refresh another process already made; and disconnecting revokes the
tokens at the provider where it names a way to. The GitHub App card makes a real webhook endpoint
and shows its URL and one-time secret; `connection-providers` no longer returns a `webhook_url`.

Previews reach a member's own runner only through its tunnel, whatever host it reports. A mention is
posted without waiting on push services, which get ten seconds per message.

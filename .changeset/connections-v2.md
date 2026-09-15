---
"@perch/connect": minor
"@perch/connectors": minor
"@perch/api": minor
"@perch/web": minor
"@perch/ui": minor
---

Connections v2: connect anything with a remote MCP server without registering an app first. Perch
discovers how to authorize at the moment you click Connect — the protected-resource document
(RFC 9728), the authorization server's metadata (RFC 8414 or OpenID Connect discovery), then who
Perch is as a client: an app you registered here, this instance's own client metadata document, or
a client registered on the spot (RFC 7591) — and completes an OAuth 2.1 round-trip with PKCE and a
resource indicator naming the server the token is for.

Vercel, Supabase and Clerk ship as connectors. **Use my own app** registers your own OAuth client
with a provider on either sign-in lane, and **Who may use it** on every connection grants it to a
bot: a connection that is yours can be lent to a bot the whole workspace talks to only on your
behalf, and both the grant and the call are refused otherwise.

---
"@perch/api": patch
---

A workspace's runner container mounts only that workspace's directory of the homes and projects
volumes (a volume subpath on Docker Engine 26+, a bind of the same directory before that), so a
member of one workspace can no longer read or write another workspace's projects or anyone else's
home. Homes are per workspace now; each member's existing home is copied into a workspace the first
time its directory is made. Starting a replacement container revokes the runner's older connect
tokens. Shared mode keeps whole volumes and is documented as single-tenant.

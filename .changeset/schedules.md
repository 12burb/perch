---
"@perch/api": minor
"@perch/jobs": minor
"@perch/db": minor
---

A bot's schedule now means the hour you meant. `timezone: Europe/London` on a bot reads
`0 9 * * 1-5` as nine in the morning there, and follows it across a daylight-saving change; a zone
name that does not exist is refused when the bot is saved. A firing Perch was down for runs late by
default, up to an hour, and a bot whose message only makes sense on time can say `catch_up: false`.
And a new schedules endpoint says, for each one, when it next fires and when it last did.

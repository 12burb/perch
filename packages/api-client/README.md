# @perch/api-client (MIT)

The TypeScript SDK for the Perch REST API, generated from the instance's `/api/openapi.json`
(spec §7.1) with `openapi-typescript` and served by `openapi-fetch` (ADR-0022).

```ts
import { createPerchClient } from "@perch/api-client";

const perch = createPerchClient({ baseUrl: "https://perch.example.com", token: process.env.PERCH_TOKEN });
const { data, error } = await perch.GET("/api/health");
if (data) console.log(data.status, data.checks.database);
```

Every path, parameter, request body, and response is typed from the document; errors follow the §7.8
shape. Regenerate after any route change:

```sh
bun run sdk:generate   # exports openapi.json from the api, then rewrites src/schema.d.ts
```

CI fails when the committed `openapi.json` drifts from what the api serves.

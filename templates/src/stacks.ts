/**
 * Starter stacks (task 4.8; spec §10's Phase 4 line "one-click templates, starter stacks").
 *
 * A stack is a handful of files and the command that runs them. Perch writes the files into a new
 * project and the Preview tab starts the command, so "new project" can be something that answers
 * on a port rather than an empty directory — which is the difference between trying Perch and
 * reading about it.
 *
 * The files live here as strings on purpose: they are part of the build, they are typechecked with
 * everything else, and there is no second packaging step between the repository and a project.
 * Every version in them is pinned, for the same reason every other version in this repository is.
 */

export type Stack = {
  /** `bun-api`, `next-app`, … — what the API and the UI call it. */
  id: string;
  name: string;
  /** One line, shown beside the name. */
  description: string;
  tags: readonly string[];
  /** The port its dev server listens on, which is also what the Preview tab watches. */
  port: number;
  /** What starts it, exactly as somebody would type it. */
  dev: string;
  /** Path → contents, written into the project in this order. */
  files: Readonly<Record<string, string>>;
};

/** `.perch/project.json` for a stack: the run command, and the preview that watches its port. */
function projectJson(stack: { dev: string; port: number; install?: string }): string {
  const run: Record<string, string> = { dev: stack.dev };
  if (stack.install) run.install = stack.install;
  return `${JSON.stringify(
    { run, preview: { command: stack.dev, port: stack.port, path: "/" } },
    null,
    2,
  )}\n`;
}

const README = (name: string, dev: string) =>
  `# ${name}

Made from a Perch starter stack. Run it:

\`\`\`sh
${dev}
\`\`\`

The Preview tab starts the same command and watches the port \`.perch/project.json\` names.
`;

const bunApi: Stack = {
  id: "bun-api",
  name: "Bun API",
  description: "An HTTP API on Bun, with a health route and one endpoint. No dependencies.",
  tags: ["bun", "typescript", "api"],
  port: 3000,
  dev: "bun --hot src/index.ts",
  files: {
    "package.json": `${JSON.stringify(
      {
        name: "bun-api",
        private: true,
        type: "module",
        scripts: { dev: "bun --hot src/index.ts", start: "bun src/index.ts" },
      },
      null,
      2,
    )}\n`,
    "src/index.ts": `const port = Number(process.env.PORT ?? 3000);

/** Everything this API knows, which is nothing yet. */
const birds: { id: number; name: string }[] = [{ id: 1, name: "perch" }];

const index = \`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Bun API</title></head>
  <body>
    <h1 id="app">Bun API</h1>
    <p>Two routes so far: <a href="/health">/health</a> and <a href="/birds">/birds</a>.</p>
    <p>Edit <code>src/index.ts</code> and save; <code>--hot</code> reloads it.</p>
  </body>
</html>\`;

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/birds") return Response.json({ birds });
    return new Response("not found", { status: 404 });
  },
});

console.log(\`listening on http://localhost:\${server.port}\`);
`,
    ".perch/project.json": projectJson({ dev: "bun --hot src/index.ts", port: 3000 }),
    "README.md": README("Bun API", "bun --hot src/index.ts"),
    ".gitignore": "node_modules/\n",
  },
};

const nextApp: Stack = {
  id: "next-app",
  name: "Next.js app",
  description: "The Next.js app router with one page, ready for `npm install && npm run dev`.",
  tags: ["next", "react", "typescript"],
  port: 3000,
  dev: "npm run dev",
  files: {
    "package.json": `${JSON.stringify(
      {
        name: "next-app",
        private: true,
        scripts: { dev: "next dev --port 3000", build: "next build", start: "next start" },
        dependencies: { next: "16.3.5", react: "19.3.0", "react-dom": "19.3.0" },
      },
      null,
      2,
    )}\n`,
    "next.config.mjs": `/** @type {import('next').NextConfig} */\nexport default {};\n`,
    "app/layout.tsx": `export const metadata = { title: "A Perch project" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    "app/page.tsx": `export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "3rem" }}>
      <h1>It runs.</h1>
      <p>Edit <code>app/page.tsx</code> and this page changes without a reload.</p>
    </main>
  );
}
`,
    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          jsx: "preserve",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          plugins: [{ name: "next" }],
        },
        include: ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    )}\n`,
    ".perch/project.json": projectJson({
      dev: "npm run dev",
      port: 3000,
      install: "npm install",
    }),
    "README.md": README("Next.js app", "npm install && npm run dev"),
    ".gitignore": "node_modules/\n.next/\n",
  },
};

const pythonApi: Stack = {
  id: "python-api",
  name: "Python API",
  description: "FastAPI under uv: one endpoint, reloading, no virtualenv to remember.",
  tags: ["python", "fastapi", "uv"],
  port: 8000,
  dev: "uv run uvicorn main:app --reload --port 8000",
  files: {
    "pyproject.toml": `[project]
name = "python-api"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["fastapi==0.141.1", "uvicorn[standard]==0.53.0"]
`,
    "main.py": `from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/birds")
def birds() -> dict[str, list[dict[str, object]]]:
    return {"birds": [{"id": 1, "name": "perch"}]}
`,
    ".perch/project.json": projectJson({
      dev: "uv run uvicorn main:app --reload --port 8000",
      port: 8000,
    }),
    "README.md": README("Python API", "uv run uvicorn main:app --reload --port 8000"),
    ".gitignore": "__pycache__/\n.venv/\n",
  },
};

const staticSite: Stack = {
  id: "static-site",
  name: "Static site",
  description: "A page, a stylesheet, and a five-line server. Nothing to install.",
  tags: ["html", "css", "bun"],
  port: 8080,
  dev: "bun serve.ts",
  files: {
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A Perch project</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main>
      <h1>It runs.</h1>
      <p>Edit <code>index.html</code> and reload.</p>
    </main>
  </body>
</html>
`,
    "style.css": `:root { color-scheme: light dark; }
body {
  font-family: system-ui, sans-serif;
  margin: 0;
  display: grid;
  place-items: center;
  min-height: 100dvh;
}
main { padding: 2rem; max-width: 40rem; }
`,
    "serve.ts": `const root = new URL("./", import.meta.url).pathname;
const port = Number(process.env.PORT ?? 8080);

const server = Bun.serve({
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(\`\${root}\${path === "/" ? "index.html" : path.slice(1)}\`);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(\`listening on http://localhost:\${server.port}\`);
`,
    ".perch/project.json": projectJson({ dev: "bun serve.ts", port: 8080 }),
    "README.md": README("Static site", "bun serve.ts"),
  },
};

/** Every stack this build ships, in the order a new project offers them. */
export const STACKS: readonly Stack[] = [bunApi, nextApp, pythonApi, staticSite];

export function stackById(id: string): Stack | undefined {
  return STACKS.find((stack) => stack.id === id);
}

/** A stack's files as the api writes them: path and contents, in a stable order. */
export function stackFiles(stack: Stack): { path: string; content: string }[] {
  return Object.entries(stack.files).map(([path, content]) => ({ path, content }));
}

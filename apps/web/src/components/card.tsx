import type { ReactNode } from "react";

/** The centered card the auth pages use (sign in, sign up, invite). */
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby="card-heading"
      className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-sm"
    >
      <h1 id="card-heading" className="mb-4 text-xl font-semibold">
        {title}
      </h1>
      {children}
    </section>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-base px-4 py-8 text-fg">
      {children}
    </main>
  );
}

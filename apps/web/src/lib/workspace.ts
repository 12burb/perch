/** The last workspace the browser opened, so "/" lands where the user left off. */
const KEY = "perch.workspace";

export function rememberWorkspace(slug: string): void {
  try {
    localStorage.setItem(KEY, slug);
  } catch {
    // storage unavailable: "/" falls back to the first membership
  }
}

export function rememberedWorkspace(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetWorkspace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}

/**
 * The browser-visible configuration, read once at module load.
 *
 * Vite inlines `import.meta.env.VITE_*` at build time, so these values are
 * baked into the bundle and are public by definition. Nothing secret belongs
 * here — only where the API lives.
 */
export interface WebEnv {
  /** Prefix for every API path. Empty means "same origin as this page". */
  apiBaseUrl: string;
}

function normaliseBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  // A trailing slash would produce `//api/...` once a path is appended.
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export const env: WebEnv = {
  apiBaseUrl: normaliseBaseUrl(import.meta.env.VITE_API_BASE_URL),
};

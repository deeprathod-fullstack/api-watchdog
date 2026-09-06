/// <reference types="vite/client" />

/**
 * Types the variables this app reads from `import.meta.env`. Without it Vite's
 * index signature hands back `any`, which defeats the point of checking them.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

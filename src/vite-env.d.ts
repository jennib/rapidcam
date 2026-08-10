/// <reference types="vite/client" />
 
interface ImportMetaEnv {
  readonly VITE_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The app's version, injected from package.json at build time (see the `define`
 * block in vite.config.ts). Declared here so the About dialog can read it
 * without a second copy of the number living in the source.
 */
declare const __APP_VERSION__: string;

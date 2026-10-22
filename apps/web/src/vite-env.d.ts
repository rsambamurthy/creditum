/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Creditum API (e.g. https://api.bank.example/api). Unset = same-origin "/api". */
  readonly VITE_API_URL?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv }

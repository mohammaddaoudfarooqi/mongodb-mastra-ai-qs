/// <reference types="vite/client" />

// Optional dev-only fake SSO JWT for exercising the real-JWT path locally (in an SSO
// deployment the platform gateway injects the JWT). VITE_SSO_HEADER overrides the header
// name it is sent under (defaults to x-sso-authorization).
interface ImportMetaEnv {
  readonly VITE_DEV_FAKE_JWT?: string;
  readonly VITE_SSO_HEADER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

// Spec 550: optional dev-only fake SSO JWT for exercising the real-JWT path
// locally (production injects the JWT at the Kanopy gateway).
interface ImportMetaEnv {
  readonly VITE_DEV_FAKE_JWT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

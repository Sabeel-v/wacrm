// Shared app code (src/lib) refers to the Next.js worker's `CloudflareEnv`.
// Inside the API worker the same bindings exist on `Env`.
type CloudflareEnv = Env

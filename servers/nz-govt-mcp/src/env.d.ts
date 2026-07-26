// This server binds no credentials, cache, or OAuth-specific fields of its own — it needs no
// upstream API key and every one of its tools is a pure function of its input. Kept as an empty
// augmentation (not deleted) so the ambient `Env` name agent.ts references always resolves, even
// as a future tool might add a real field here.
export {};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional: only makes the ambient `Env` name resolve.
  interface Env {}
}

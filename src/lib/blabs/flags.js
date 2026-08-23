export function envFlagTrue(raw) {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
export function isRebrand() { return envFlagTrue(process.env.BLABS_REBRAND); }
export function isDemoLock() { return envFlagTrue(process.env.BLABS_DEMO_LOCK); }
export function readBlabsFlags() { return { rebrand: isRebrand(), demoLock: isDemoLock() }; }

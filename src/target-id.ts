export function isUsableTargetId(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value === "." || value === "..") return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

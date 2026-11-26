/** Random id. Not crypto.randomUUID: that needs https, and this also runs from http://<mac>.local. */
export function uid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * UUID v4 generator with fallback for insecure contexts (HTTP).
 * Safari restricts crypto.randomUUID() to secure contexts (HTTPS),
 * but crypto.getRandomValues() works everywhere.
 */
export function uuid() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

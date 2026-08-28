export function slugify(value: unknown, fallback = 'item') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return slug || fallback;
}

export function stableId(prefix: string, ...parts: unknown[]) {
  const base = parts.map((part) => slugify(part, 'x')).join('-');
  return slugify(`${prefix}-${base}`, prefix);
}

export function nowIso() {
  return new Date().toISOString();
}

export function deepClone(value: any): any {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function slugify(s) {
  if (typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

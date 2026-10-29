import { readFileSync } from 'node:fs';

const overrides = JSON.parse(readFileSync(
  new URL('../config/google-copy.json', import.meta.url), 'utf8',
));

// Keep Google copy separate from Shopify and the Meta feed. Variant IDs prevent
// a 900 mL refill from changing the fixed 450 mL hand wash in a mixed set.
export function getGoogleCopy(id, handle) {
  const copy = overrides[id];
  if (!copy) return {};
  if (copy.handle !== handle) {
    throw new Error(`Google copy product mismatch for variant ${id}`);
  }
  return copy;
}

// Structured attributes have their own quoting, inside the outer CSV quoting.
export function structuredCopy(content) {
  return content ? `trained_algorithmic_media:"${content.replace(/"/g, '""')}"` : '';
}

export function googleText(record, field) {
  const plain = record[field] || '';
  const structured = record[`structured_${field}`] || '';
  if (Boolean(plain) === Boolean(structured)) {
    throw new Error(`provide exactly one of ${field} and structured_${field}`);
  }
  if (plain) return plain;
  const match = structured.match(/^trained_algorithmic_media:"((?:[^"]|"")+)"$/s);
  if (!match) throw new Error(`invalid structured_${field}`);
  return match[1].replace(/""/g, '"');
}

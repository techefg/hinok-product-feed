import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildGoogleFeedRows, buildMetaFeedRows, validateGoogleFeedRows,
  GOOGLE_HEADERS, META_HEADERS, csvEscape,
} from '../src/generate-feed.js';
import { googleText, structuredCopy } from '../src/google-copy.js';

const copies = JSON.parse(readFileSync(new URL('../config/google-copy.json', import.meta.url)));
const record = (row, headers = GOOGLE_HEADERS) => Object.fromEntries(headers.map((h, i) => [h, row[i]]));
function product({ id = '52662593388676', handle = 'the-spray-hand-wash-set', title = 'The Spray & Hand Wash Set', variant = '30.4 fl.oz. (900 mL)', inventory = 3 } = {}) {
  return {
    id: 'gid://shopify/Product/123', title, handle, description: 'Original Shopify description.',
    productType: 'Set', images: { nodes: [{ url: 'https://example.com/product.jpg' }] },
    variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}`, title: variant,
      price: '52.00', compareAtPrice: '60.00', inventoryQuantity: inventory, inventoryPolicy: 'DENY',
      inventoryItem: { inventoryLevel: { quantities: [{ quantity: inventory }] } }, selectedOptions: [],
    }] },
  };
}

test('900 mL mixed set retains the 450 mL hand wash and commercial fields', () => {
  const rows = buildGoogleFeedRows([product()]);
  validateGoogleFeedRows(rows);
  const row = record(rows[0]);
  assert.match(googleText(row, 'title'), /Spray 900 mL \+ Hand Wash 450 mL$/);
  assert.match(googleText(row, 'description'), /900 mL.*450 mL/);
  assert.equal(row.title, '');
  assert.equal(row.description, '');
  assert.equal(row.id, '52662593388676');
  assert.equal(row.price, '60.00 USD');
  assert.equal(row.sale_price, '52.00 USD');
  assert.equal(row.availability, 'in_stock');
  assert.equal(row.link, 'https://hinok.us/products/the-spray-hand-wash-set?variant=52662593388676');
});

test('450 mL mixed set and future variants cannot become a standalone hand wash', () => {
  const small = record(buildGoogleFeedRows([product({ id: '52662593355908', variant: '15.2 fl.oz. (450 mL)' })])[0]);
  assert.match(googleText(small, 'title'), /Spray 450 mL \+ Hand Wash 450 mL$/);
  const future = record(buildGoogleFeedRows([product({ id: '999' })])[0]);
  assert.match(future.title, /Spray & Hand Wash Set/);
  assert.doesNotMatch(future.title, /Gentle Hand Wash/);
});

test('Google copy overrides do not reach Meta or change out-of-stock status', () => {
  const source = product({ inventory: 0 });
  const meta = record(buildMetaFeedRows([source])[0], META_HEADERS);
  const google = record(buildGoogleFeedRows([source])[0]);
  assert.equal(meta.title, 'The Spray & Hand Wash Set - 30.4 fl.oz. (900 mL)');
  assert.equal(meta.description, source.description);
  assert.equal(meta.availability, 'out of stock');
  assert.equal(google.availability, 'out_of_stock');
});

test('description-only overrides keep the existing bestseller title', () => {
  const row = record(buildGoogleFeedRows([product({ id: '51556562141316', handle: 'the-spray-set', title: 'The Spray Set' })])[0]);
  assert.equal(row.title, 'Hinok Fabric Refresher Spray Set – Jeju Hinoki Cypress – 30.4 fl oz (900 mL)');
  assert.equal(row.structured_title, '');
  assert.match(googleText(row, 'description'), /Jeju Hinoki Cypress water/);
});

test('unselected products preserve their source description', () => {
  const row = record(buildGoogleFeedRows([product({ id: '999', handle: 'other-product', title: 'Other Product' })])[0]);
  assert.equal(row.description, 'Original Shopify description.');
  assert.equal(row.structured_description, '');
});

test('structured text preserves commas, colons, and double quotes through CSV', () => {
  const text = 'Test: 12" bottle, 450 mL';
  const structured = structuredCopy(text);
  assert.equal(googleText({ title: '', structured_title: structured }, 'title'), text);
  assert.equal(csvEscape(structured), '"trained_algorithmic_media:""Test: 12"""" bottle, 450 mL"""');
});

test('validation rejects conflicting, malformed, missing and overlong copy', () => {
  const original = buildGoogleFeedRows([product()])[0];
  for (const [field, value] of [['title', 'Conflicting title'], ['structured_title', 'broken'], ['structured_title', ''], ['structured_title', structuredCopy('x'.repeat(151))], ['structured_description', structuredCopy('x'.repeat(5001))]]) {
    const row = [...original]; row[GOOGLE_HEADERS.indexOf(field)] = value;
    assert.throws(() => validateGoogleFeedRows([row]), /Google feed validation failed/);
  }
});

test('all configured copy fits the feed and stays on its intended product', () => {
  for (const [id, copy] of Object.entries(copies)) {
    validateGoogleFeedRows(buildGoogleFeedRows([product({ id, handle: copy.handle })]));
    assert.throws(() => buildGoogleFeedRows([product({ id, handle: 'wrong-product' })]), /product mismatch/);
  }
});

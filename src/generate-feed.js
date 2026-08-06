import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

const {
  SHOPIFY_STORE_URL,
  SHOPIFY_ACCESS_TOKEN,
  STORE_DOMAIN = 'https://hinok.us',
  BRAND = 'Hinok',
} = process.env;

if (!SHOPIFY_STORE_URL || !SHOPIFY_ACCESS_TOKEN) {
  console.error(
    'ERROR: Missing required env vars — SHOPIFY_STORE_URL, SHOPIFY_ACCESS_TOKEN',
  );
  process.exit(1);
}

const API_VERSION = '2025-01';
const GRAPHQL_URL = `https://${SHOPIFY_STORE_URL}/admin/api/${API_VERSION}/graphql.json`;

// ── Shopify GraphQL ─────────────────────────────────────────────────────────

const PUBLICATIONS_QUERY = `
query {
  publications(first: 20) {
    nodes {
      id
      name
    }
  }
}`;

const LOCATIONS_QUERY = `
query {
  locations(first: 20) {
    nodes {
      id
      name
    }
  }
}`;

const PRODUCTS_QUERY = `
query ($cursor: String, $publicationId: ID!, $locationId: ID!) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      publishedOnPublication(publicationId: $publicationId)
      title
      description
      handle
      tags
      productType
      images(first: 10) {
        nodes { url }
      }
      variants(first: 100) {
        nodes {
          id
          title
          price
          compareAtPrice
          inventoryQuantity
          inventoryPolicy
          selectedOptions { name value }
          inventoryItem {
            inventoryLevel(locationId: $locationId) {
              quantities(names: ["available"]) {
                quantity
              }
            }
          }
          image { url }
        }
      }
    }
  }
}`;

const BUNDLE_QUERY = `
query ($productId: ID!, $locationId: ID!) {
  product(id: $productId) {
    bundleComponents(first: 20) {
      nodes {
        quantity
        optionSelections {
          parentOption { name }
          componentOption { name }
          values { value }
        }
        componentVariants(first: 20) {
          nodes {
            selectedOptions { name value }
            inventoryItem {
              inventoryLevel(locationId: $locationId) {
                quantities(names: ["available"]) {
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
}`;

async function graphql(query, variables = {}) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status}: ${text}`);
  }

  const { data, errors } = await res.json();
  if (errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  }
  return data;
}

async function getOnlineStorePublicationId() {
  const data = await graphql(PUBLICATIONS_QUERY);
  const pub = data.publications.nodes.find((p) => p.name === 'Online Store');
  if (!pub) {
    throw new Error(
      'Online Store publication not found. Available: ' +
        data.publications.nodes.map((p) => p.name).join(', '),
    );
  }
  console.log(`Online Store publication: ${pub.id}`);
  return pub.id;
}

async function getWarehouseLocationId() {
  const data = await graphql(LOCATIONS_QUERY);
  const loc = data.locations.nodes.find((l) => l.name === 'Monarch Warehouse US');
  if (!loc) {
    throw new Error(
      'Monarch Warehouse US location not found. Available: ' +
        data.locations.nodes.map((l) => l.name).join(', '),
    );
  }
  console.log(`Warehouse location: ${loc.id}`);
  return loc.id;
}

async function fetchAllProducts() {
  const publicationId = await getOnlineStorePublicationId();
  const locationId = await getWarehouseLocationId();
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(PRODUCTS_QUERY, { cursor, publicationId, locationId });
    for (const product of data.products.nodes) {
      if (product.publishedOnPublication) {
        products.push(product);
      }
    }
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
  }

  // Fetch bundle components for products with no location-level inventory
  for (const product of products) {
    const isBundle = product.variants.nodes.every(
      (v) => getLocationQty(v.inventoryItem) == null,
    );
    if (!isBundle) continue;

    const data = await graphql(BUNDLE_QUERY, { productId: product.id, locationId });
    product.bundleComponents = data.product.bundleComponents;
    console.log(`  ↳ Resolved bundle components: "${product.title}"`);
  }

  return products;
}

// ── CSV helpers ─────────────────────────────────────────────────────────────

/** Extract numeric ID from Shopify GID (e.g. gid://shopify/ProductVariant/123 → "123") */
function numericId(gid) {
  return gid.split('/').pop();
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── Bundle inventory ────────────────────────────────────────────────────────

function getLocationQty(inventoryItem) {
  return inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity;
}

/**
 * For a bundle variant, calculate availability from component inventory
 * at the target location. Returns null for non-bundle products.
 */
function getBundleLocationQty(product, variant) {
  const components = product.bundleComponents?.nodes;
  if (!components?.length) return null;

  const parentOpts = variant.selectedOptions;
  let minQty = Infinity;

  for (const comp of components) {
    const { optionSelections, componentVariants, quantity: needed } = comp;

    let matched = null;

    // Only consider selections that map a parent option to a component option
    const mapped = (optionSelections || []).filter((s) => s.parentOption);

    if (!mapped.length) {
      // Fixed component (e.g. Spray Bottle) → use first variant
      matched = componentVariants.nodes[0];
    } else {
      // Match parent option values to component option values
      for (const cv of componentVariants.nodes) {
        const allMatch = mapped.every((sel) => {
          const parentVal = parentOpts.find(
            (o) => o.name === sel.parentOption.name,
          )?.value;
          const compVal = cv.selectedOptions.find(
            (o) => o.name === sel.componentOption.name,
          )?.value;
          return parentVal === compVal;
        });
        if (allMatch) { matched = cv; break; }
      }
    }

    if (!matched) return 0; // can't resolve → treat as OOS

    const compQty = getLocationQty(matched.inventoryItem) ?? 0;
    const available = Math.floor(compQty / (needed || 1));
    minQty = Math.min(minQty, available);
  }

  return minQty === Infinity ? null : minQty;
}

// ── Feed generation ─────────────────────────────────────────────────────────

const META_HEADERS = [
  'id',
  'item_group_id',
  'title',
  'description',
  'availability',
  'quantity_to_sell_on_facebook',
  'inventory',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'product_type',
  'google_product_category',
];

function buildMetaFeedRows(products) {
  const rows = [];

  for (const product of products) {
    const images = product.images.nodes.map((n) => n.url);
    const mainImage = images[0] || '';
    const additionalImages = images.slice(1).join(',');
    const baseLink = `${STORE_DOMAIN}/products/${product.handle}`;
    const groupId = numericId(product.id);

    for (const variant of product.variants.nodes) {
      const id = numericId(variant.id);
      const price = parseFloat(variant.price);
      const compareAt = variant.compareAtPrice
        ? parseFloat(variant.compareAtPrice)
        : null;

      // Meta pricing convention:
      //   price      = original / compare-at price (when on sale) or regular price
      //   sale_price = discounted price (only when compare-at exists and is higher)
      const onSale = compareAt && compareAt > price;
      const metaPrice = onSale
        ? `${compareAt.toFixed(2)} USD`
        : `${price.toFixed(2)} USD`;
      const metaSalePrice = onSale ? `${price.toFixed(2)} USD` : '';

      // Location inventory: direct for regular products, component-based for bundles
      const locationQty = getLocationQty(variant.inventoryItem);
      const bundleQty = getBundleLocationQty(product, variant);
      const qty = locationQty != null ? locationQty : bundleQty ?? variant.inventoryQuantity;
      const inStock = qty > 0 || variant.inventoryPolicy === 'CONTINUE';

      // Meta needs explicit quantity fields to override its default OOS marking.
      // Without these, Meta was inferring quantity=0 from missing data even when
      // CSV said "in stock" — verified 2026-05-15 (5 SKUs incl. The Hand Wash
      // showed in_stock=0 in catalog while Shopify had 50-113 inventory).
      const metaQty = inStock ? Math.max(qty ?? 0, 1) : 0;

      // Append variant title only when it differs from "Default Title"
      const title =
        variant.title && variant.title !== 'Default Title'
          ? `${product.title} - ${variant.title}`
          : product.title;

      const variantImage = variant.image?.url || mainImage;
      const link = `${baseLink}?variant=${id}`;

      rows.push([
        id,
        groupId,
        title,
        product.description || product.title,
        inStock ? 'in stock' : 'out of stock',
        metaQty,
        metaQty,
        'new',
        metaPrice,
        metaSalePrice,
        link,
        variantImage,
        additionalImages,
        BRAND,
        product.productType || '',
        'Health & Beauty > Personal Care > Cosmetics > Skin Care',
      ]);
    }
  }

  return rows;
}

// ── Google Merchant Center feed ────────────────────────────────────────────

const GOOGLE_HEADERS = [
  'id',
  'item_group_id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'sale_price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'identifier_exists',
  'google_product_category',
  'product_type',
  'is_bundle',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
];

function productKey(product) {
  return product.title.toLowerCase();
}

function googleFamily(product) {
  const key = productKey(product);
  if (key.includes('spray')) return 'spray';
  if (key.includes('shampoo') || key.includes('conditioner')) return 'hair_care';
  return 'body_care';
}

function googleRole(product) {
  const key = productKey(product);
  if (key.includes('gift set')) return 'gift_set';
  if (key.includes('discovery set')) return 'discovery_set';
  if (key.includes('refill')) return 'refill';
  if (key.includes('spray set')) return 'starter_set';
  if (key.includes('to go')) return 'travel';
  if (key.includes('bottle')) return 'accessory';
  return 'core';
}

function googleCategory(product) {
  const key = productKey(product);
  if (key.includes('spray')) return '6240'; // Fabric Refreshers
  if (key.includes('shampoo')) return '543615';
  if (key.includes('conditioner')) return '543616';
  if (key.includes('hand wash')) return '3208';
  if (key.includes('body wash')) return '2747';
  if (key.includes('lotion') || key.includes('hand balm')) return '2592';
  if (key.includes('discovery set')) return '475';
  return '';
}

function googleProductType(product) {
  const family = googleFamily(product);
  const role = googleRole(product);
  if (family === 'spray') return `Home Care > Fabric Care > ${role}`;
  if (family === 'hair_care') return `Personal Care > Hair Care > ${role}`;
  return `Personal Care > Bath & Body > ${role}`;
}

function extractSize(product, variant) {
  const source = variant.title && variant.title !== 'Default Title'
    ? variant.title
    : product.title;
  const match = source.match(/(\d+(?:\.\d+)?)\s*fl\.?\s*oz\.?\s*\((\d+)\s*mL\)/i);
  return match ? `${match[1]} fl oz (${match[2]} mL)` : '';
}

function googleTitle(product, variant) {
  const key = productKey(product);
  let title;
  if (key.includes('spray gift set')) {
    title = 'Hinok Fabric Refresher Gift Set – Jeju Hinoki Cypress';
  } else if (key.includes('spray refill')) {
    title = 'Hinok Fabric Refresher Refill – Jeju Hinoki Cypress';
  } else if (key.includes('spray set')) {
    title = 'Hinok Fabric Refresher Spray Set – Jeju Hinoki Cypress';
  } else if (key.includes('spray to go')) {
    title = 'Hinok Travel Fabric Refresher – Jeju Hinoki Cypress';
  } else if (key.includes('spray bottle')) {
    title = 'Hinok Refillable Spray Bottle – Recycled Plastic';
  } else if (key.includes('body wash refill')) {
    title = 'Hinok Body Wash Refill – Jeju Hinoki Cypress';
  } else if (key.includes('body wash')) {
    title = 'Hinok Sulfate-Free Body Wash – Jeju Hinoki Cypress';
  } else if (key.includes('hand wash refill')) {
    title = 'Hinok Hand Wash Refill – Jeju Hinoki Cypress';
  } else if (key.includes('hand wash')) {
    title = 'Hinok Gentle Hand Wash – Jeju Hinoki Cypress';
  } else if (key.includes('lotion refill')) {
    title = 'Hinok Hand & Body Lotion Refill – Jeju Hinoki Cypress';
  } else if (key.includes('lotion')) {
    title = 'Hinok Hand & Body Lotion – Jeju Hinoki Cypress';
  } else if (key.includes('hand balm')) {
    title = 'Hinok Fast-Absorbing Hand Balm – Jeju Hinoki Cypress';
  } else if (key.includes('shampoo refill')) {
    title = 'Hinok Shampoo Refill – Jeju Hinoki Cypress';
  } else if (key.includes('shampoo')) {
    title = 'Hinok Scalp Care Shampoo – Jeju Hinoki Cypress';
  } else if (key.includes('conditioner refill')) {
    title = 'Hinok Conditioner Refill – Jeju Hinoki Cypress';
  } else if (key.includes('conditioner')) {
    title = 'Hinok Silicone-Free Conditioner – Jeju Hinoki Cypress';
  } else if (key.includes('discovery set')) {
    title = 'Hinok Hair & Body Discovery Set – 4 Travel Minis';
  } else {
    title = `Hinok ${product.title.replace(/^The\s+/i, '')}`;
  }

  const size = extractSize(product, variant);
  return size ? `${title} – ${size}` : title;
}

function googlePriority(product, variant) {
  const key = productKey(product);
  const size = extractSize(product, variant);
  if (key.includes('spray gift set')) return 'high';
  if (key.includes('spray set') && size.includes('900')) return 'high';
  if (key.includes('spray refill') && size.includes('900')) return 'high';
  if (key.includes('spray set') || key.includes('spray refill')) return 'medium';
  return 'low';
}

function buildGoogleFeedRows(products) {
  const rows = [];

  for (const product of products) {
    const images = product.images.nodes.map((n) => n.url);
    const mainImage = images[0] || '';
    const additionalImage = images[1] || '';
    const baseLink = `${STORE_DOMAIN}/products/${product.handle}`;
    const groupId = product.variants.nodes.length > 1 ? numericId(product.id) : '';
    const role = googleRole(product);
    const isBundle = ['gift_set', 'discovery_set', 'starter_set'].includes(role);

    for (const variant of product.variants.nodes) {
      const id = numericId(variant.id);
      const price = parseFloat(variant.price);
      const compareAt = variant.compareAtPrice
        ? parseFloat(variant.compareAtPrice)
        : null;
      const onSale = compareAt && compareAt > price;
      const locationQty = getLocationQty(variant.inventoryItem);
      const bundleQty = getBundleLocationQty(product, variant);
      const qty = locationQty != null ? locationQty : bundleQty ?? variant.inventoryQuantity;
      const inStock = qty > 0 || variant.inventoryPolicy === 'CONTINUE';
      const availabilityLabel = variant.inventoryPolicy === 'CONTINUE' && qty <= 0
        ? 'continue_selling'
        : inStock ? 'in_stock' : 'out_of_stock';

      rows.push([
        id,
        groupId,
        googleTitle(product, variant),
        product.description || product.title,
        inStock ? 'in_stock' : 'out_of_stock',
        'new',
        `${(onSale ? compareAt : price).toFixed(2)} USD`,
        onSale ? `${price.toFixed(2)} USD` : '',
        `${baseLink}?variant=${id}`,
        variant.image?.url || mainImage,
        additionalImage,
        BRAND,
        'no',
        googleCategory(product),
        googleProductType(product),
        isBundle ? 'yes' : 'no',
        googleFamily(product),
        role,
        price >= 50 ? 'aov_50_plus' : price >= 30 ? 'aov_30_49' : 'aov_under_30',
        googlePriority(product, variant),
        availabilityLabel,
      ]);
    }
  }

  return rows;
}

function validateGoogleFeedRows(rows) {
  const seen = new Set();
  const required = ['id', 'title', 'description', 'availability', 'price', 'link', 'image_link'];
  const errors = [];

  rows.forEach((row, index) => {
    const record = Object.fromEntries(GOOGLE_HEADERS.map((header, i) => [header, row[i]]));
    for (const field of required) {
      if (!record[field]) errors.push(`row ${index + 2}: missing ${field}`);
    }
    if (seen.has(record.id)) errors.push(`row ${index + 2}: duplicate id ${record.id}`);
    seen.add(record.id);
    if (record.title.length > 150) errors.push(`row ${index + 2}: title exceeds 150 chars`);
    if (!/^https:\/\//.test(record.link)) errors.push(`row ${index + 2}: invalid link`);
    if (!/^https:\/\//.test(record.image_link)) errors.push(`row ${index + 2}: invalid image_link`);
    if (!/^[0-9]+(?:\.[0-9]{2}) USD$/.test(record.price)) {
      errors.push(`row ${index + 2}: invalid price ${record.price}`);
    }
  });

  if (errors.length) {
    throw new Error(`Google feed validation failed:\n${errors.join('\n')}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log('Fetching products from Shopify…');
  const products = await fetchAllProducts();
  console.log(`Fetched ${products.length} product(s)`);

  // Log bundle / set products for verification
  for (const p of products) {
    if (/set|bundle|kit/i.test(p.title)) {
      console.log(
        `  ✓ Bundle/Set: "${p.title}" — ${p.variants.nodes.length} variant(s)`,
      );
    }
  }

  const metaRows = buildMetaFeedRows(products);
  const metaCsv = [
    META_HEADERS.join(','),
    ...metaRows.map((r) => r.map(csvEscape).join(',')),
  ].join('\n');
  const googleRows = buildGoogleFeedRows(products);
  validateGoogleFeedRows(googleRows);
  const googleCsv = [
    GOOGLE_HEADERS.join(','),
    ...googleRows.map((r) => r.map(csvEscape).join(',')),
  ].join('\n');

  console.log(`Generated ${metaRows.length} Meta feed item(s)`);
  console.log(`Generated ${googleRows.length} Google feed item(s); validation passed`);

  if (dryRun) {
    console.log('Dry run — no files written');
    return;
  }

  const outDir = join(process.cwd(), 'docs');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const metaPath = join(outDir, 'feed.csv');
  writeFileSync(metaPath, metaCsv, 'utf-8');
  console.log(`Written → ${metaPath}`);

  const googlePath = join(outDir, 'google-feed.csv');
  writeFileSync(googlePath, googleCsv, 'utf-8');
  console.log(`Written → ${googlePath}`);
}

main().catch((err) => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});

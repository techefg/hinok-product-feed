import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

const {
  SHOPIFY_STORE_URL,
  SHOPIFY_ACCESS_TOKEN,
  STORE_DOMAIN = 'https://hinok.com',
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

const PRODUCTS_QUERY = `
query ($cursor: String, $publicationId: ID!) {
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
          image { url }
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

async function fetchAllProducts() {
  const publicationId = await getOnlineStorePublicationId();
  const products = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await graphql(PRODUCTS_QUERY, { cursor, publicationId });
    for (const product of data.products.nodes) {
      if (product.publishedOnPublication) {
        products.push(product);
      }
    }
    hasNextPage = data.products.pageInfo.hasNextPage;
    cursor = data.products.pageInfo.endCursor;
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

// ── Feed generation ─────────────────────────────────────────────────────────

const HEADERS = [
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
  'product_type',
  'google_product_category',
];

function buildFeedRows(products) {
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

      // In stock if qty > 0 OR inventory policy allows continued selling
      const inStock =
        variant.inventoryQuantity > 0 || variant.inventoryPolicy === 'CONTINUE';

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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
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

  const rows = buildFeedRows(products);
  const csv = [
    HEADERS.join(','),
    ...rows.map((r) => r.map(csvEscape).join(',')),
  ].join('\n');

  console.log(`Generated ${rows.length} feed item(s)`);

  const outDir = join(process.cwd(), 'docs');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const outPath = join(outDir, 'feed.csv');
  writeFileSync(outPath, csv, 'utf-8');
  console.log(`Written → ${outPath}`);
}

main().catch((err) => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});

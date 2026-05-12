#!/usr/bin/env node
// Download product images from Shopify Admin API
// Usage:
// SHOP=<your-shop> TOKEN=<admin-token> node scripts/download_shopify_images.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOP = process.env.SHOP; // e.g. your-shop.myshopify.com (without https)
const TOKEN = process.env.TOKEN; // Admin API access token
if (!SHOP || !TOKEN) {
  console.error('Missing SHOP or TOKEN env vars. Usage: SHOP=your-shop.myshopify.com TOKEN=xxx node scripts/download_shopify_images.js');
  process.exit(1);
}

const API_VERSION = '2024-10';
const OUT_DIR = path.join(process.cwd(), 'downloaded_images');
fs.mkdirSync(OUT_DIR, { recursive: true });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'X-Shopify-Access-Token': TOKEN,
        'Accept': 'application/json'
      }
    };
    https.get(url, opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ json, headers: res.headers, statusCode: res.statusCode });
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadUrl(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(outPath, { force: true });
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      fs.unlinkSync(outPath, { force: true });
      reject(err);
    });
  });
}

async function run() {
  console.log('Starting download to', OUT_DIR);
  let since_id = 0;
  let totalImages = 0;
  while (true) {
    const url = `https://${SHOP}/admin/api/${API_VERSION}/products.json?limit=250${since_id ? `&since_id=${since_id}` : ''}`;
    process.stdout.write(`Fetching products since_id=${since_id}... `);
    const { json, statusCode } = await fetchJson(url);
    if (statusCode !== 200) {
      console.error('Failed to fetch products', statusCode);
      break;
    }
    const products = json.products || [];
    console.log(`got ${products.length} products`);
    if (!products.length) break;

    for (const p of products) {
      const pid = p.id;
      const images = p.images || [];
      if (!images.length) continue;
      const pDir = path.join(OUT_DIR, String(pid));
      fs.mkdirSync(pDir, { recursive: true });
      for (const img of images) {
        const src = img.src;
        if (!src) continue;
        const filename = path.basename(new URL(src).pathname) || (`img_${Date.now()}.jpg`);
        const outPath = path.join(pDir, filename);
        try {
          await downloadUrl(src, outPath);
          totalImages++;
          process.stdout.write('.');
        } catch (err) {
          process.stdout.write('x');
        }
      }
    }

    // Advance since_id to last product id
    since_id = products[products.length - 1].id;
    // if fewer than 250, done
    if (products.length < 250) break;
  }

  console.log(`\nDone. Downloaded approx ${totalImages} images into ${OUT_DIR}`);
}

run().catch(err => {
  console.error('Error:', err.message || err);
  process.exitCode = 1;
});

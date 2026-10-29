import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Pure-function tests (no network) ───────────────────────────────

const extract: any = require('../src/pipeline/property-extract');

test('extractListingFromHtml parses a typical Moroccan listing (fr)', () => {
  const html = `
  <html><head>
    <meta name="description" content="Surface totale : 560 m² ; titré ; chambre : 02 ; salon : 01 ; cuisine : oui ; SDB : 02 ; terrasse ; piscine ; Route de Fes -Marrakech">
    <meta property="og:title" content="Villa à vendre meublée - Roue de Fes, Marrakech">
  </head><body>
    <h1>Villa à vendre meublée - Roue de Fes, Marrakech</h1>
    <select><option value="prixvente1">250.000 à 500.000 dhs</option></select>
    Réference de produit : VVM-344 | 8560000 dhs | Route De Fes
    <img src="/assets/img/produit/a-VVM-344 (1).jpeg">
    <img src="/assets/img/produit/b-VVM-344 (2).jpeg">
    <img src="/assets/img/produit/a-VVM-344 (1).jpeg">
    <img src="/logo.png">
    <img src="https://cdn.example.com/ad-banner.jpg">
    <p>À vendre, belle villa meublée avec piscine privée, située sur un terrain de 560 m² titré. ${'Long paragraph. '.repeat(30)}</p>
  </body></html>`;
  const listing = extract.extractListingFromHtml(html, 'https://www.example-immo.com/produit/vvm-344/vente-villa.html');
  assert.equal(listing.title, 'Villa à vendre meublée - Roue de Fes, Marrakech');
  assert.equal(listing.reference, 'VVM-344');
  assert.equal(listing.price, 8560000);
  assert.equal(listing.priceCurrency, 'MAD');
  assert.equal(listing.landAreaM2, 560);
  assert.equal(listing.builtAreaM2, null); // never inferred
  assert.equal(listing.bedrooms, 2);
  assert.equal(listing.bathrooms, 2);
  assert.equal(listing.images.length, 2); // dedupe + logo/ad excluded
  assert.ok(listing.images[0].startsWith('https://www.example-immo.com/assets/img/produit/'));
  assert.ok(listing.description.length > 100);
});

test('structured data adapter reads JSON-LD Product with offers and image', () => {
  const html = `<script type="application/ld+json">
  {"@type":"Product","name":"Villa Targa 400m²","description":"Belle villa","sku":"V-99",
   "image":["https://img.example.com/1.jpg","https://img.example.com/2.jpg"],
   "floorSize":{"@type":"QuantitativeValue","value":400},
   "offers":{"@type":"Offer","price":4200000,"priceCurrency":"MAD"}}
  </script><h1>fallback</h1>`;
  const listing = extract.extractListingFromHtml(html, 'https://www.example.com/p/1');
  assert.equal(listing.title, 'Villa Targa 400m²');
  assert.equal(listing.reference, 'V-99');
  assert.equal(listing.price, 4200000);
  assert.equal(listing.builtAreaM2, 400);
  assert.equal(listing.images.length, 2);
});

test('relative and lazy-loaded gallery images resolve and dedupe', () => {
  const html = `
    <img data-src="/img/photo1.jpg">
    <img data-lazy="img/photo2.jpg">
    <img srcset="/img/photo3.jpg 800w, /img/photo3-large.jpg 1600w">
    <img src="/img/photo1.jpg">
    <img src="data:image/png;base64,xxx">
    <img src="javascript:alert(1)">
  `;
  const listing = extract.extractListingFromHtml(html, 'https://site.com/listing/x.html?utm=1');
  assert.equal(listing.images.length, 3);
  assert.ok(listing.images[0] === 'https://site.com/img/photo1.jpg');
  assert.ok(listing.images[1] === 'https://site.com/listing/img/photo2.jpg'); // relative resolved against page path
  assert.ok(listing.images[2].startsWith('https://site.com/img/photo3')); // srcset best candidate
});

test('price extraction ignores filter dropdowns and takes the listing amount', () => {
  const html = `
  <select><option>250.000 à 500.000 dhs</option><option>1.000.000 à 2.000.000 dhs</option></select>
  <div class="price">3.450.000 DH</div>`;
  const listing = extract.extractListingFromHtml(html, 'https://x.com/p');
  assert.equal(listing.price, 3450000);
  assert.equal(listing.priceCurrency, 'MAD');
});

// ─── SSRF guard (unit-level; live network tests marked separately) ────

test('isPrivateIp logic via adapter behavior: localhost and private hosts rejected before any fetch', async () => {
  // We test the guard by calling fetchSafeUrl with private targets and asserting
  // the specific refusal messages (DNS/connect happens only after the check).
  await assert.rejects(() => extract.fetchSafeUrl('http://localhost:8090/x'), /Blocked host: localhost/);
  await assert.rejects(() => extract.fetchSafeUrl('http://127.0.0.1/x'), /Private address refused/);
  await assert.rejects(() => extract.fetchSafeUrl('http://192.168.1.10/x'), /Private address refused/);
  await assert.rejects(() => extract.fetchSafeUrl('http://10.0.0.5/x'), /Private address refused/);
  await assert.rejects(() => extract.fetchSafeUrl('http://172.16.0.1/x'), /Private address refused/);
  await assert.rejects(() => extract.fetchSafeUrl('http://169.254.169.254/latest/meta-data/'), /Private address refused/);
  await assert.rejects(() => extract.fetchSafeUrl('http://[::1]/x'), /Private address refused|DNS resolution failed/);
  await assert.rejects(() => extract.fetchSafeUrl('file:///etc/passwd'), /Only http\(s\)/);
  await assert.rejects(() => extract.fetchSafeUrl('ftp://x'), /Only http\(s\)/);
});

// ─── Property presentation helpers ────────────────────────────────────

const pres: any = require('../src/pipeline/property-presentation');

test('segmentNarration splits 45-60s narration into <=14s segments without losing words', () => {
  const words = Array.from({ length: 130 }, (_, i) => `mot${i}`);
  const narration = words.join(' ');
  const segs = pres.segmentNarration(narration, 14);
  assert.ok(segs.length >= 3 && segs.length <= 6);
  for (const s of segs) assert.ok(s.split(' ').length <= Math.floor(14 * 2.6));
  assert.equal(segs.join(' ').split(/\s+/).filter(Boolean).length, 130); // no words lost
  // tiny tail merges into previous segment
  const two = pres.segmentNarration('un deux trois');
  assert.equal(two.length, 1);
});

test('cost display avoids unsupported fixed pricing', () => {
  const est = pres.estimateCost(52);
  assert.equal(est.higgsfieldUsd, 'Check provider billing');
  assert.match(est.note, /model, resolution and account/);
});

// ─── Job store lifecycle ─────────────────────────────────────────────

const propJobs: any = require('../src/pipeline/property-jobs');

function freshStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ianews-prop-'));
  process.env.IANEWS_PROP_INDEX = path.join(tmp, 'index.json');
  fs.writeFileSync(process.env.IANEWS_PROP_INDEX, '{}');
  delete require.cache[require.resolve('../src/pipeline/property-jobs')];
  const mod = require('../src/pipeline/property-jobs');
  return { store: new mod.PropJobStore(), tmp };
}

test('property job lifecycle: draft -> generate -> retry-safe -> cancel; clientToken idempotent', () => {
  const { store } = freshStore();
  const base = {
    sourceUrl: 'https://example.com/p/1', language: 'fr' as const, voiceId: 'v',
    narration: 'Une belle villa sur un terrain de 560 m² titré avec piscine. Contactez nous pour une visite.',
    listing: { title: 'Villa', reference: 'R1', location: 'Marrakech', price: 1, priceCurrency: 'MAD',
      landAreaM2: 560, builtAreaM2: null, bedrooms: 2, bathrooms: 2, description: 'x', amenities: [], images: ['https://e.com/1.jpg'] },
    branding: { agencyName: 'Promo Immo', contactLine: '' },
    avatarProvided: true,
  };
  const j1 = store.createDraft({ ...base, clientToken: 'tok-A' });
  assert.equal(j1.status, 'draft');
  assert.equal(j1.stages.extract.status, 'completed');
  const j2 = store.createDraft({ ...base, clientToken: 'tok-A' });
  assert.equal(j1.id, j2.id); // idempotent
  const sub = store.submitForGeneration(j1.id);
  assert.equal(sub.status, 'queued');
  assert.equal(sub.stages.extract.status, 'completed');
  // failure + retry keeps completed stages
  store.updateStage(j1.id, 'voice', { status: 'failed', error: 'TTS down' });
  store.update(j1.id, { status: 'failed', error: 'TTS down' });
  const retried = store.submitForGeneration(j1.id);
  assert.equal(retried.status, 'queued');
  assert.equal(retried.stages.voice.status, 'pending');
  assert.equal(retried.stages.extract.status, 'completed');
  const canceled = store.cancel(j1.id);
  assert.equal(canceled.status, 'canceled');
  assert.throws(() => store.submitForGeneration(j1.id), /draft or failed/);
});

test('narration validation rejects too-short scripts before queueing', () => {
  const { store } = freshStore();
  const j = store.createDraft({
    sourceUrl: 'x', language: 'fr', voiceId: 'v', narration: 'trop court',
    listing: { title: '', reference: '', location: '', price: null, priceCurrency: null,
      landAreaM2: null, builtAreaM2: null, bedrooms: null, bathrooms: null,
      description: '', amenities: [], images: [] },
    branding: { agencyName: '', contactLine: '' }, avatarProvided: false,
  });
  assert.throws(() => store.submitForGeneration(j.id), /Narration is empty or too short/);
});

// ─── Composition plan ─────────────────────────────────────────────────

const compose: any = require('../src/pipeline/property-compose');

test('planCaptions uses only reviewed facts and never invents features', () => {
  const caps = compose.planCaptions({
    sourceUrl: 'x', language: 'fr', voiceId: 'v', narration: 'n',
    listing: { title: 'Villa Route de Fès', reference: '', location: 'Route de Fès',
      price: 8560000, priceCurrency: 'MAD', landAreaM2: 560, builtAreaM2: null,
      bedrooms: 2, bathrooms: 2, description: '', amenities: [], images: [] },
    branding: { agencyName: 'Promo Immo Marrakech', contactLine: '' },
  } as any, 'fr');
  assert.equal(caps.opening, 'Villa Route de Fès');
  assert.ok(caps.highlights.some((h: string) => h.includes('560')));
  assert.ok(caps.highlights.some((h: string) => h.includes('560')));
  assert.ok(!caps.highlights.some((h: string) => /investissement|rentabilité/i.test(h))); // no invented claims
  assert.ok(caps.closing.includes('Promo Immo Marrakech'));
});

test('generated Remotion project sequences segments consecutively at measured durations', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotion-gen-'));
  const plan = [
    { text: 'seg 1', audioFile: 'audio/seg_01.mp3', avatarClip: 'avatar/seg_01.mp4', durationSec: 12.5, photoFile: 'photos/photo_01.jpg', caption: 'Villa' },
    { text: 'seg 2', audioFile: 'audio/seg_02.mp3', avatarClip: 'avatar/seg_02.mp4', durationSec: 11.2, photoFile: 'photos/photo_02.jpg', caption: 'Contactez-nous' },
  ];
  const { entryDir } = compose.generateRemotionProject({
    jobDir: tmp, plan, fps: 30,
    input: { sourceUrl: 'x', language: 'fr', voiceId: 'v', narration: 'n',
      listing: { title: 'T', reference: '', location: '', price: null, priceCurrency: null,
        landAreaM2: null, builtAreaM2: null, bedrooms: null, bathrooms: null,
        description: '', amenities: [], images: [] },
      branding: { agencyName: 'A', contactLine: '' } } as any,
  });
  const src = fs.readFileSync(path.join(entryDir, 'index.tsx'), 'utf-8');
  // durations rounded to frames and used for Sequence boundaries
  assert.match(src, /"duration":375/);
  assert.match(src, /"from":375,"duration":336/);
  assert.match(src, /"totalFrames":711/);
  assert.match(src, /"shots":\[/); // consecutive offsets, no overlap
  assert.match(src, /"rtl":false/);
  // Arabic variant flips RTL
  const plan2 = plan.slice();
  const src2 = (() => {
    const { entryDir: d2 } = compose.generateRemotionProject({
      jobDir: tmp + '2', plan: plan2, fps: 30,
      input: { sourceUrl: 'x', language: 'ar', voiceId: 'v', narration: 'n',
        listing: { title: 'T', reference: '', location: '', price: null, priceCurrency: null,
          landAreaM2: null, builtAreaM2: null, bedrooms: null, bathrooms: null,
          description: '', amenities: [], images: [] },
        branding: { agencyName: 'A', contactLine: '' } } as any,
    });
    return fs.readFileSync(path.join(d2, 'index.tsx'), 'utf-8');
  })();
  assert.match(src2, /"rtl":true/);
  assert.match(fs.readFileSync(path.join(tmp + "2", "render", "Presentation.tsx"), "utf8"), /data.rtl/);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmp + '2', { recursive: true, force: true });
});

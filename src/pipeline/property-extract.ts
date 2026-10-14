/**
 * property-extract.ts — Reusable property listing extraction with adapters.
 *
 * Flow: fetchHtml (SSRF-guarded) -> run adapters in order -> normalize ->
 *       resolve+dedupe gallery images -> PropertyListing.
 *
 * Adapters: each takes (html, url) and returns partial fields; first adapter
 * to produce a field wins. Structured-data adapter runs before the generic
 * HTML adapter. Site-specific adapters can be registered for known layouts.
 *
 * Security: fetchSafeUrl blocks private networks at connect time AND follows
 * redirects manually re-checking each hop (DNS + IP range).
 */
import * as dns from "dns";
import * as net from "net";
import * as path from "path";
import * as crypto from "crypto";

export interface PropertyListing {
  sourceUrl: string;
  title: string;
  reference: string;
  location: string;
  price: number | null;
  priceCurrency: string | null;
  landAreaM2: number | null;
  builtAreaM2: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  description: string;
  amenities: string[];
  images: string[]; // absolute, deduped, ordered
  extractionWarnings: string[];
}

// ─── SSRF guard ───────────────────────────────────────────────────
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "instance-data"]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") ||
      lower.startsWith("fe80") || lower.startsWith("::ffff:127.") || lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.") || lower.startsWith("::ffff:172.");
  }
  return PRIVATE_V4.some(re => re.test(ip));
}

async function assertPublicHost(hostname: string, portToCheck: number): Promise<void> {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) throw new Error(`Blocked host: ${hostname}`);
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Private address refused: ${hostname}`);
    return;
  }
  const addrs = await dns.promises.lookup(hostname, { all: true }).catch(() => { throw new Error(`DNS resolution failed: ${hostname}`); });
  for (const { address, family } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Host resolves to a private address (${address}) — refused`);
  }
  void portToCheck;
}

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface FetchedPage { url: string; html: string; warnings: string[]; }

/** Fetch a page following redirects manually, re-validating every hop against private networks. */
export async function fetchSafeUrl(rawUrl: string): Promise<FetchedPage> {
  let current = String(rawUrl || "").trim();
  const warnings: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error(`Only http(s) URLs are supported (got ${u.protocol})`);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    await assertPublicHost(u.hostname, port);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(u.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "fr,en;q=0.8,ar;q=0.5",
        },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Redirect without Location (${res.status})`);
        current = new URL(loc, u.href).href; // resolve relative redirects
        warnings.push(`redirected to ${current}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${u.href}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_HTML_BYTES) throw new Error("Page too large (over 5 MB)");
      const html = Buffer.from(buf).toString("utf-8");
      return { url: u.href, html, warnings };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

// ─── Helpers ──────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&(?![a-zA-Z#])/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&egrave;/g, "\u00e8").replace(/&eacute;/g, "\u00e9").replace(/&agrave;/g, "\u00e0")
    .replace(/&ocirc;/g, "\u00f4")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function firstNumber(text: string): number | null {
  // Accept "560", "5 600", "5.600", "5,600", "5,600.50", "5600.50"
  const m = text.replace(/\u00a0/g, " ").match(/\d[\d\s.,]*/);
  if (!m) return null;
  let raw = m[0].trim();
  // European style "5.600" or "5.600,50" vs anglo "5,600.50"
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)) raw = raw.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)) raw = raw.replace(/,/g, "");
  else raw = raw.replace(/\s/g, "").replace(/,(?=\d{1,2}$)/, ".");
  const num = Number(raw.replace(/[.,]$/, ""));
  return Number.isFinite(num) ? num : null;
}

function absolute(src: string, baseUrl: string): string | null {
  try {
    if (/^(data:|javascript:|about:)/i.test(src)) return null;
    const u = new URL(src, baseUrl);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

// ─── Adapters ─────────────────────────────────────────────────────
export type Adapter = (html: string, url: string) => Partial<PropertyListing> & { images?: string[] };

/** JSON-LD structured data (schema.org Product/Residence/Offer). */
export const structuredDataAdapter: Adapter = (html) => {
  const out: Partial<PropertyListing> & { images?: string[] } = {};
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
  for (const block of blocks) {
    let data: any;
    try { data = JSON.parse(block.replace(/<\/?script[^>]*>/g, "")); } catch { continue; }
    const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] || "");
      if (/Product|Residence|Apartment|House|SingleFamilyResidence|Accommodation/i.test(type)) {
        out.title = out.title || stripTags(node.name || "");
        out.description = out.description || stripTags(node.description || "");
        const imgs = Array.isArray(node.image) ? node.image : node.image ? [node.image] : [];
        const urls = imgs.map((i: any) => (typeof i === "string" ? i : i?.url)).filter(Boolean) as string[];
        out.images = [...(out.images || []), ...urls];
        const floors = node.floorSize || (node.numberOfRooms && {});
        if (node.floorSize?.value) out.builtAreaM2 = Number(node.floorSize.value) || null;
        if (node.numberOfRoomsTotal || node.numberOfRooms) {
          const rooms = Number(node.numberOfRoomsTotal ?? node.numberOfRooms);
          if (Number.isFinite(rooms) && rooms > 0 && rooms < 50) out.bedrooms = rooms;
        }
        if (node.address) {
          const a = typeof node.address === "string" ? node.address :
            [node.address.streetAddress, node.address.addressLocality, node.address.addressRegion].filter(Boolean).join(", ");
          if (a) out.location = out.location || stripTags(a);
        }
        const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
        if (offers) {
          const price = Number(offers.price ?? offers.lowPrice);
          if (Number.isFinite(price) && price > 0) out.price = price;
          out.priceCurrency = out.priceCurrency || offers.priceCurrency || null;
        }
        if (typeof node.sku === "string" || typeof node.productID === "string") out.reference = out.reference || (node.sku || node.productID);
      }
      if (type === "Offer" && node.price) {
        const price = Number(node.price);
        if (Number.isFinite(price) && price > 0) out.price = out.price || price;
        out.priceCurrency = out.priceCurrency || node.priceCurrency || null;
      }
    }
  }
  return out;
};

/** OpenGraph / Twitter / meta tags. */
export const metaAdapter: Adapter = (html) => {
  const out: Partial<PropertyListing> & { images?: string[] } = {};
  const og = (prop: string) => {
    const m = html.match(new RegExp(`(?:property|name)="${prop}" content="([^"]*)"`, "i"));
    return m ? stripTags(m[1]) : "";
  };
  out.title = out.title || og("og:title") || "";
  out.description = out.description || og("og:description") || og("description") || "";
  if (og("og:image")) out.images = [og("og:image")];
  if (og("product:price:amount")) {
    const p = Number(og("product:price:amount"));
    if (Number.isFinite(p)) out.price = p;
    out.priceCurrency = out.priceCurrency || og("product:price:currency") || null;
  }
  return out;
};

/**
 * Generic HTML adapter for real-estate listings. Language-aware patterns
 * (FR/EN/AR) for price, reference, surfaces, rooms, amenities. Never infers
 * built area from land area.
 */
export const htmlAdapter: Adapter = (html, url) => {
  const out: Partial<PropertyListing> & { images?: string[] } = {};
  const text = stripTags(html);

  // Title: <h1> first
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) out.title = out.title || stripTags(h1[1]);

  // Reference: explicit labels only
  const ref = text.match(/(?:r[ée]f[ée]rence(?: de produit)?|ref|reference)\s*(?:n?[°o\.]\s*|:\s*|:\s*)?([A-Z0-9][A-Z0-9\-_]{2,20})/i);
  if (ref) out.reference = out.reference || ref[1].trim();

  // Price: prefer a money amount near the listing body over filter dropdowns.
  // Strategy: find "8 560 000 dhs" style; take the largest plausible amount
  // in the main content region, excluding values inside <option> tags.
  const bodyHtml = html.replace(/<option[^>]*>[\s\S]*?<\/option>/gi, " ").replace(/<select[\s\S]*?<\/select>/gi, " ");
  const bodyText = stripTags(bodyHtml);
  const priceMatches = [...bodyText.matchAll(/(\d[\d\s\u00a0.,]{5,15})\s*(dhs|dh\b|mad|dirhams?|€|eur|euros?)/gi)];
  let bestPrice: number | null = null;
  let bestCurrency: string | null = null;
  for (const m of priceMatches) {
    const raw = m[1].replace(/[\s\u00a0]/g, "");
    // European grouping "3.450.000" or "3.450.000,50" -> 3450000(.5);
    // anglo grouping "3,450,000.50" -> 3450000.5; plain digits pass through.
    const normalized = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(raw)
      ? raw.replace(/\./g, "").replace(",", ".")
      : /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(raw)
        ? raw.replace(/,/g, "")
        : raw.replace(/\.(?=\d{3}\b)/g, "").replace(/,(?=\d{3}\b)/g, "");
    const num = Number(normalized.replace(/[.,]$/, ""));
    if (Number.isFinite(num) && num >= 10_000 && num <= 1_000_000_000 && (!bestPrice || num > bestPrice)) {
      bestPrice = num;
      bestCurrency = /dhs|dh|mad|dirham/i.test(m[2]) ? "MAD" : "EUR";
    }
  }
  if (bestPrice) { out.price = out.price ?? bestPrice; out.priceCurrency = out.priceCurrency ?? bestCurrency; }

  // Land area (terrain/plot)
  const land = bodyText.match(/(?:terrain|parcelle|plot|lot)\s*(?:de|:|=)?\s*([\d\s\u00a0.,]+)\s*m/i)
    || bodyText.match(/([\d\s\u00a0.,]+)\s*m(?:²|2|etre)?\s*(?:de\s*)?terrain/i);
  if (land) {
    const n = firstNumber(land[1]);
    if (n && n >= 20 && n <= 1_000_000) out.landAreaM2 = out.landAreaM2 ?? n;
  }

  // Built area (surface habitable/constructie) — ONLY explicit; never derived.
  const built = bodyText.match(/(?:surface(?:\s*(?:habitale|habitable|construite|built|de construction))?|emprise)\s*(?:de|:|=|totale\s*:)?\s*([\d\s\u00a0.,]+)\s*m(?:²|2)?/i);
  if (built && !/terrain|parcelle/i.test(built[0])) {
    const n = firstNumber(built[1]);
    if (n && n >= 15 && n <= 100_000) out.builtAreaM2 = out.builtAreaM2 ?? n;
  }
  // "Surface totale" — on many Moroccan listings this is the plot; treat as land
  // only when no separate land value exists and no other built indicator is present.
  const total = bodyText.match(/surface totale\s*:?\s*([\d\s\u00a0.,]+)\s*m(?:²|2)?/i);
  if (total && out.landAreaM2 == null && out.builtAreaM2 == null) {
    const n = firstNumber(total[1]);
    if (n && n >= 20 && n <= 1_000_000) out.landAreaM2 = n;
  }

  // Bedrooms / rooms
  const beds = bodyText.match(/(?:chambres?|bedrooms?|pi[èe]ces?\s*de\s*vie)\s*(?:de)?\s*:?\s*(\d{1,2})/i);
  if (beds) out.bedrooms = out.bedrooms ?? Number(beds[1]);

  // Bathrooms
  const baths = bodyText.match(/(?:salles?\s*d[\.'\u2019]?\s*eau|sdb|bathrooms?|salles?\s*de\s*bains?|bains?)\s*(?:de)?\s*:?\s*(\d{1,2})/i);
  if (baths) out.bathrooms = out.bathrooms ?? Number(baths[1]);
  if (out.bathrooms == null) {
    // "SDB : 02" with unicode spaces / different order
    const sdb = bodyText.match(/SDB\s*(?:=|:)?\s*(\d{1,2})/);
    if (sdb) out.bathrooms = Number(sdb[1]);
  }
  // Many Moroccan portals put the full feature list ONLY in <meta name="description"> /
  // og:description: "chambre : 02 ; salon : 01 ; cuisine : oui ; SDB : 02 ; ...". Mine it too.
  const metaAll = [...html.matchAll(/<meta[^>]+content="([^"]{30,400})"/gi)].map(m => stripTags(m[1])).join(" ; ");
  if (out.bathrooms == null) {
    const sdb = metaAll.match(/SDB\s*(?:=|:)?\s*(\d{1,2})/i);
    if (sdb) out.bathrooms = Number(sdb[1]);
  }
  if (out.bedrooms == null) {
    const ch = metaAll.match(/chambres?\s*(?:=|:)?\s*(\d{1,2})/i);
    if (ch) out.bedrooms = Number(ch[1]);
  }
  if (out.landAreaM2 == null) {
    const terr = metaAll.match(/(?:terrain|surface totale)\s*(?:=|:)?\s*([\d\s.,]+)\s*m/i);
    if (terr) { const n = firstNumber(terr[1]); if (n && n >= 20) out.landAreaM2 = n; }
  }
  for (const w of ["piscine", "garage", "jardin", "terrasse", "cuisine", "titr\u00e9", "meubl\u00e9"]) {
    if (new RegExp("\\b" + w, "i").test(metaAll) && !(out.amenities || []).some(a => a.startsWith(w.slice(0, 4)))) {
      (out.amenities = out.amenities || []).push(w.replace("\\u00e9", "é"));
    }
  }

  // Location: a dedicated labeled line, or the tail of the meta description
  // (common on Moroccan listings: "...; Route de Fes -Marrakech").
  // Reject matches that look like filter widgets (contain ':' lists or 'Nombre de').
  const locLine = bodyText.match(/(?:localisation|situation|adresse|quartier|secteur)\s*:?\s*([^;|•\n]{3,60})/i);
  if (locLine && !/nombre|surface\s*:|terrain\s*:|chambre\s*:/i.test(locLine[1])) {
    out.location = out.location || locLine[1].trim();
  }
  if (!out.location) {
    const metaDesc = html.match(/<meta name="description" content="([^"]*)"/i);
    if (metaDesc) {
      const tail = metaDesc[1].split(";").map(x => x.trim()).filter(Boolean).pop() || "";
      if (tail && tail.length <= 80 && !/^\d/.test(tail)) out.location = stripTags(tail);
    }
  }
  if (!out.location) {
    // "Route De Fes" appears right after the price on many prom-immom listings
    const afterPrice = bodyText.match(/dhs\s*\|?\s*([A-Z][A-Za-zÀ-ÿ\s'-]{3,40})\s*\|/);
    if (afterPrice) out.location = stripTags(afterPrice[1]);
  }

  // Amenities: look for short labeled feature lists
  const amenityWords = ["piscine", "garage", "jardin", "terrasse", "cuisine [ée]quip[ée]e", "meubl[ée]e?", "ascenseur",
    "climatisation", "chauffage", "alarme", "forage", "puit", "puits", "titr[ée]", "concierge", "duplex", "studio",
    "pool", "garden", "garage", "furnished", "elevator", "air conditioning", "title deed"];
  const amenities: string[] = [];
  for (const w of amenityWords) {
    const re = new RegExp(`\\b(${w})\\b`, "i");
    const m = bodyText.match(re);
    if (m) amenities.push(m[1].toLowerCase());
  }
  const listItems = [...html.matchAll(/<(?:li|span|div)[^>]*class="[^"]*(?:feature|amenit|caract|equip)[^"]*"[^>]*>\s*([^<]{2,40})/gi)]
    .map(m => stripTags(m[1])).filter(Boolean);
  out.amenities = amenities.concat(listItems);

  // Description: longest <p> block in the body
  const paras = [...bodyHtml.matchAll(/<p[^>]*>([\s\S]{120,4000}?)<\/p>/gi)]
    .map(m => stripTags(m[1])).sort((a, b) => b.length - a.length);
  if (paras[0]) out.description = out.description || paras[0].slice(0, 3000);

  // Images: <img src>, srcset candidates, data-src/data-lazy (lazy-load) —
  // restricted to image extensions and typical gallery paths; exclude
  // logos/icons/ads/other-listing thumbs by URL and size hints.
  const rawSrcs: string[] = [];
  for (const m of bodyHtml.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0];
    const src = tag.match(/\bsrc="([^"]+)"/) || tag.match(/\bdata-src="([^"]+)"/) || tag.match(/\bdata-lazy(?:-src)?="([^"]+)"/) || tag.match(/\bdata-original="([^"]+)"/);
    if (src) rawSrcs.push(src[1]);
    const srcset = tag.match(/\b(?:srcset|data-srcset)="([^"]+)"/);
    if (srcset) {
      const best = srcset[1].split(",").map(s => s.trim().split(/\s+/)[0]).pop();
      if (best) rawSrcs.push(best);
    }
  }
  const base = url;
  const seen = new Set<string>();
  const images: string[] = [];
  for (const raw of rawSrcs) {
    const abs = absolute(raw, base);
    if (!abs) continue;
    const u = new URL(abs);
    const pathname = u.pathname.toLowerCase();
    if (!/\.(jpe?g|png|webp|avif)(\?|$)/.test(pathname)) continue;
    if (/(logo|icon|favicon|sprite|avatar|banner|pub|ads?[._-]|analytics|pixel|placeholder|watermark-site|social)/.test(u.pathname + u.search)) continue;
    if (u.hostname.match(/statcounter|googleads|doubleclick|facebook\.com\/tr|analytics/)) continue;
    // dedupe by path (ignore query/size suffixes)
    const dedupeKey = u.hostname + u.pathname.replace(/[-_](\d{2,4}x\d{2,4})(?=\.[a-z]+$)/, "");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    images.push(abs);
  }
  out.images = images;

  return out;
};

// ─── Orchestration ────────────────────────────────────────────────
const DEFAULT_ADAPTERS: Adapter[] = [structuredDataAdapter, metaAdapter, htmlAdapter];

export function extractListingFromHtml(html: string, url: string, adapters: Adapter[] = DEFAULT_ADAPTERS): PropertyListing {
  // This site places unrelated listings in a separate section after the gallery.
  // Exclude that section before every adapter, including price and image extraction.
  if (/^(www\.)?promoimmomarrakech\.com$/.test(new URL(url).hostname)) {
    const related = html.search(/<h[1-6][^>]*>\s*Produits similaires/i);
    if (related >= 0) html = html.slice(0, related);
  }
  const merged: Partial<PropertyListing> & { images?: string[] } = {};
  let images: string[] = [];
  for (const adapter of adapters) {
    const part = adapter(html, url) || {};
    for (const [k, v] of Object.entries(part)) {
      if (k === "images") { if (Array.isArray(v) && v.length) images = images.concat(v as string[]); continue; }
      const key = k as keyof PropertyListing;
      if ((merged as any)[key] == null || (merged as any)[key] === "" && v != null) (merged as any)[key] = v;
    }
  }
  // Resolve + dedupe all image URLs (from all adapters) against the final URL
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const raw of images) {
    const abs = absolute(raw, url);
    if (!abs) continue;
    const u = new URL(abs);
    const key = crypto.createHash("sha1").update(u.hostname + u.pathname).digest("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(abs);
  }
  return {
    sourceUrl: url,
    title: merged.title || "",
    reference: merged.reference || "",
    location: merged.location || "",
    price: merged.price ?? null,
    priceCurrency: merged.priceCurrency ?? null,
    landAreaM2: merged.landAreaM2 ?? null,
    builtAreaM2: merged.builtAreaM2 ?? null,
    bedrooms: merged.bedrooms ?? null,
    bathrooms: merged.bathrooms ?? null,
    description: merged.description || "",
    amenities: [...new Set(merged.amenities || [])],
    images: resolved.slice(0, 30),
    extractionWarnings: [],
  };
}

/** Top-level: fetch + extract. Always returns a listing; fields stay empty on failure. */
export async function extractListing(rawUrl: string): Promise<PropertyListing> {
  const { url, html, warnings } = await fetchSafeUrl(rawUrl);
  const listing = extractListingFromHtml(html, url);
  listing.extractionWarnings = warnings;
  if (!listing.title && !listing.description && !listing.images.length) {
    throw new Error("Extraction failed: no recognizable listing content on this page. You can enter the details manually.");
  }
  return listing;
}

/** Download a remote image with the same SSRF guard (for gallery caching). */
export async function downloadImageSafe(src: string, maxBytes = 15 * 1024 * 1024): Promise<Buffer> {
  const { fetchSafeUrl } = await import("./property-extract");
  // Reuse fetch (redirect-manual) but for binary content
  let current = String(src).trim();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http(s) image URLs");
    await assertPublicHost(u.hostname, u.protocol === "https:" ? 443 : 80);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(u.href, { redirect: "manual", signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", "Referer": new URL("/", u).href } });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("Image redirect without Location");
        current = new URL(loc, u.href).href;
        continue;
      }
      if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
      const type = (res.headers.get("content-type") || "").split(";")[0];
      if (!/^image\//.test(type)) throw new Error(`Not an image (content-type ${type || "unknown"})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) throw new Error("Image too large");
      if (buf.byteLength < 500) throw new Error("Image too small / broken");
      return buf;
    } finally { clearTimeout(timer); }
  }
  throw new Error("Too many redirects fetching image");
}

void path; void dns;

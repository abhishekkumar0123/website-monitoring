import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

const DEFAULT_USER_AGENT = "website-monitoring-bot/1.0 (+https://github.com/)";

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(raw).toLowerCase());
}

function sanitizePathForFile(p) {
  // Keep folder structure, but prevent traversal and weird characters.
  const cleaned = p
    .replace(/\\/g, "/")
    .replace(/\.\.+/g, ".")
    .replace(/[^a-zA-Z0-9/_\-\.]/g, "_")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
  return cleaned || "index";
}

function normalizeUrl(u) {
  const url = new URL(u);
  url.hash = "";
  // Normalize trailing slash: keep "/" for root, otherwise remove.
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function isSkippableHref(href) {
  const h = href.trim().toLowerCase();
  return (
    h === "" ||
    h.startsWith("#") ||
    h.startsWith("mailto:") ||
    h.startsWith("tel:") ||
    h.startsWith("javascript:") ||
    h.startsWith("data:")
  );
}

function extractLinksFromHtml(html) {
  const out = [];
  const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function extractScriptSrcsFromHtml(html) {
  const out = [];
  const re = /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function extractSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

async function fetchText(url, { timeoutMs, userAgent }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(t);
  }
}

async function fetchBinary(url, { timeoutMs, userAgent }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": userAgent, accept: "*/*" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buf, contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const target = process.env.TARGET_URL || "https://zerobounce.net/";
  const base = new URL(target);
  if (!base.protocol.startsWith("http")) throw new Error(`Unsupported TARGET_URL protocol: ${base.protocol}`);

  const userAgent = process.env.USER_AGENT || DEFAULT_USER_AGENT;
  const maxPages = envInt("MAX_PAGES", 200);
  const maxAssets = envInt("MAX_ASSETS", 2000);
  const timeoutMs = envInt("FETCH_TIMEOUT_MS", 25000);
  const sameOriginOnly = envBool("SAME_ORIGIN_ONLY", true);
  const allowQuery = envBool("ALLOW_QUERY_URLS", false);

  const outPagesDir = process.env.OUT_PAGES_DIR || "pages";
  const outAssetsDir = process.env.OUT_ASSETS_DIR || "assets";
  const tmpDir = ".tmp_fetch";

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(path.join(tmpDir, outPagesDir), { recursive: true });
  await mkdir(path.join(tmpDir, outAssetsDir), { recursive: true });

  const visitedPages = new Set();
  const toVisit = [];

  function enqueuePage(urlStr) {
    try {
      const u = new URL(urlStr, base);
      if (sameOriginOnly && u.origin !== base.origin) return;
      if (!allowQuery) u.search = "";
      const norm = normalizeUrl(u.toString());
      if (!visitedPages.has(norm) && visitedPages.size + toVisit.length < maxPages) {
        toVisit.push(norm);
      }
    } catch {
      // ignore
    }
  }

  // 1) Prefer sitemap.xml for "all pages".
  const sitemapCandidates = [
    new URL("/sitemap.xml", base).toString(),
    new URL("/sitemap_index.xml", base).toString(),
    new URL("/sitemap-index.xml", base).toString(),
  ];
  let seededFromSitemap = false;
  for (const sm of sitemapCandidates) {
    try {
      const res = await fetchText(sm, { timeoutMs, userAgent });
      if (res.ok && res.text && res.text.includes("<loc>")) {
        for (const loc of extractSitemapLocs(res.text)) enqueuePage(loc);
        if (toVisit.length > 0) {
          seededFromSitemap = true;
          break;
        }
      }
    } catch {
      // ignore sitemap failures
    }
  }

  // 2) Always include homepage as seed (and as fallback if sitemap fails).
  enqueuePage(base.toString());
  if (!seededFromSitemap) {
    // If we didn't get sitemap, still ensure root is first.
    toVisit.sort((a, b) => (a === base.toString() ? -1 : b === base.toString() ? 1 : 0));
  }

  const jsAssets = new Set();
  function addAsset(urlStr) {
    try {
      const u = new URL(urlStr, base);
      if (sameOriginOnly && u.origin !== base.origin) return;
      const norm = normalizeUrl(u.toString());
      if (jsAssets.size < maxAssets) jsAssets.add(norm);
    } catch {
      // ignore
    }
  }

  const pageErrors = [];
  while (toVisit.length > 0 && visitedPages.size < maxPages) {
    const next = toVisit.shift();
    if (!next || visitedPages.has(next)) continue;
    visitedPages.add(next);

    let html = "";
    try {
      const res = await fetchText(next, { timeoutMs, userAgent });
      if (!res.ok) {
        pageErrors.push({ url: next, status: res.status });
        continue;
      }
      html = res.text || "";
    } catch (e) {
      pageErrors.push({ url: next, status: "fetch_error", error: String(e) });
      continue;
    }

    // Save HTML snapshot
    const u = new URL(next);
    const relPath = sanitizePathForFile(u.pathname === "/" ? "index" : u.pathname);
    const pageFile = path.join(tmpDir, outPagesDir, `${relPath}.html`);
    await mkdir(path.dirname(pageFile), { recursive: true });
    await writeFile(pageFile, html, "utf8");

    // Discover more pages
    for (const href of extractLinksFromHtml(html)) {
      if (isSkippableHref(href)) continue;
      enqueuePage(href);
    }

    // Collect JS assets from script tags
    for (const src of extractScriptSrcsFromHtml(html)) {
      if (isSkippableHref(src)) continue;
      addAsset(src);
    }
  }

  // Fetch JS assets
  const assetErrors = [];
  for (const assetUrl of jsAssets) {
    const u = new URL(assetUrl);
    const rel = sanitizePathForFile(u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname);
    const outFile = path.join(tmpDir, outAssetsDir, rel);
    try {
      const res = await fetchBinary(assetUrl, { timeoutMs, userAgent });
      if (!res.ok) {
        assetErrors.push({ url: assetUrl, status: res.status });
        continue;
      }
      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, res.buf);
    } catch (e) {
      assetErrors.push({ url: assetUrl, status: "fetch_error", error: String(e) });
    }
  }

  // Write a small manifest (helps debugging diffs)
  const manifest = {
    target: base.toString(),
    fetchedAt: new Date().toISOString(),
    config: { maxPages, maxAssets, timeoutMs, sameOriginOnly, allowQuery },
    pages: Array.from(visitedPages),
    assets: Array.from(jsAssets),
    pageErrors,
    assetErrors,
  };
  await writeFile(path.join(tmpDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Copy from tmp into repo workspace (without needing external tools).
  // We do it by overwriting the output dirs wholesale in workflow, but here we only produce tmp.
  console.log(
    JSON.stringify(
      {
        pagesFetched: visitedPages.size,
        assetsFetched: jsAssets.size,
        pageErrors: pageErrors.length,
        assetErrors: assetErrors.length,
        tmpDir,
        outPagesDir,
        outAssetsDir,
      },
      null,
      2,
    ),
  );
}

await main();


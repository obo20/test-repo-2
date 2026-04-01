import { load } from 'cheerio';
import { dbQueries } from './db';
import { fetchAllPosts, fetchPost } from './ghost';
import { checkLink } from './checker';

const LINK_CONCURRENCY = 8; // simultaneous link checks per post

// ── Simple concurrency limiter ────────────────────────────────────────────────

async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  );
  return results;
}

// ── Link extraction ───────────────────────────────────────────────────────────

interface ExtractedLink {
  href: string;
  text: string | null;
}

function extractLinks(html: string): ExtractedLink[] {
  const $ = load(html);
  // Use a Map so we deduplicate by href but keep the first anchor text seen.
  const links = new Map<string, string | null>();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if ((href.startsWith('http://') || href.startsWith('https://')) && !links.has(href)) {
      const raw = $(el).text().trim().replace(/\s+/g, ' ');
      links.set(href, raw || null);
    }
  });

  return [...links.entries()].map(([href, text]) => ({ href, text }));
}

// ── Core: scan a list of posts ────────────────────────────────────────────────

async function scanPosts(scanId: number, postMetas: { id: string; title: string; url: string }[], apiKey: string): Promise<void> {
  dbQueries.updateScan(scanId, { total_posts: postMetas.length });

  let totalLinks = 0;
  let flaggedCount = 0;

  for (let i = 0; i < postMetas.length; i++) {
    const meta = postMetas[i];

    // Fetch full HTML now — keeps the initial pagination fast and memory-lean.
    let post: Awaited<ReturnType<typeof fetchPost>>;
    try {
      post = await fetchPost(meta.id, apiKey);
    } catch (err) {
      console.warn(`  [SKIP] Could not fetch HTML for "${meta.title}": ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (!post.html) continue;

    const links = extractLinks(post.html);
    if (links.length === 0) continue;

    console.log(
      `[scan:${scanId}] Post ${i + 1}/${postMetas.length}: "${post.title}" — ${links.length} link(s)`
    );

    const tasks = links.map(({ href, text }) => async () => {
      const result = await checkLink(href);

      if (result.status !== 'healthy') {
        console.log(
          `  [${result.status.toUpperCase()}] ${href}${result.reason ? ` — ${result.reason}` : ''}`
        );
        dbQueries.insertFlaggedLink({
          scan_id: scanId,
          post_url: post.url,
          post_title: post.title,
          link: result.url,
          link_text: text,
          link_status: result.status,
          http_status: result.httpStatus ?? null,
          reason: result.reason ?? null,
        });
        flaggedCount++;
      }

      return result;
    });

    await withConcurrency(tasks, LINK_CONCURRENCY);

    totalLinks += links.length;
    dbQueries.updateScan(scanId, { total_links: totalLinks, flagged_count: flaggedCount });
  }

  const completedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
  dbQueries.updateScan(scanId, {
    status: 'completed',
    completed_at: completedAt,
    total_links: totalLinks,
    flagged_count: flaggedCount,
  });

  console.log(
    `[scan:${scanId}] Done — ${totalLinks} links checked, ${flaggedCount} flagged`
  );
}

// ── Full blog scan ────────────────────────────────────────────────────────────

export async function runScan(scanId: number): Promise<void> {
  const ghostKey = process.env.GHOST_KEY;
  if (!ghostKey) {
    const msg = 'GHOST_KEY environment variable is not set';
    dbQueries.updateScan(scanId, { status: 'failed', error: msg });
    throw new Error(msg);
  }

  console.log(`\n[scan:${scanId}] Starting full blog scan…`);

  try {
    const posts = await fetchAllPosts(ghostKey);
    await scanPosts(scanId, posts, ghostKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const completedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    dbQueries.updateScan(scanId, { status: 'failed', completed_at: completedAt, error: message });
    console.error(`[scan:${scanId}] Failed: ${message}`);
    throw err;
  }
}

// ── Single post scan ──────────────────────────────────────────────────────────

export async function runPostScan(scanId: number, postId: string): Promise<void> {
  const ghostKey = process.env.GHOST_KEY;
  if (!ghostKey) {
    const msg = 'GHOST_KEY environment variable is not set';
    dbQueries.updateScan(scanId, { status: 'failed', error: msg });
    throw new Error(msg);
  }

  console.log(`\n[scan:${scanId}] Starting single-post scan for post "${postId}"…`);

  try {
    const postMeta = await fetchPost(postId, ghostKey);
    await scanPosts(scanId, [postMeta], ghostKey);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const completedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    dbQueries.updateScan(scanId, { status: 'failed', completed_at: completedAt, error: message });
    console.error(`[scan:${scanId}] Failed: ${message}`);
    throw err;
  }
}

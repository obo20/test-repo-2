import 'dotenv/config';
import express, { Request, Response, Router } from 'express';
import path from 'path';
import { openDb, dbQueries } from './db';
import { runScan, runPostScan } from './scanner';

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Router (all actual routes live here) ─────────────────────────────────────

const router = Router();

// POST /scan/trigger — kick off a full blog scan
router.post('/scan/trigger', (_req: Request, res: Response) => {
  if (!process.env.GHOST_KEY) {
    res.status(500).json({ error: 'GHOST_KEY environment variable is not set' });
    return;
  }

  const scanId = dbQueries.createScan();

  runScan(scanId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scan:${scanId}] Unhandled error: ${msg}`);
  });

  res.status(202).json({
    message: 'Scan started',
    scan_id: scanId,
    status_url: `/scan/${scanId}/status`,
    results_url: `/scan/${scanId}/results`,
  });
});

// POST /scan/post/:postId — scan a single Ghost post by ID
router.post('/scan/post/:postId', (req: Request, res: Response) => {
  if (!process.env.GHOST_KEY) {
    res.status(500).json({ error: 'GHOST_KEY environment variable is not set' });
    return;
  }

  const { postId } = req.params;
  const scanId = dbQueries.createScan();

  runPostScan(scanId, postId).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scan:${scanId}] Unhandled error: ${msg}`);
  });

  res.status(202).json({
    message: `Scan started for post "${postId}"`,
    scan_id: scanId,
    status_url: `/scan/${scanId}/status`,
    results_url: `/scan/${scanId}/results`,
  });
});

// GET /scan/:id/status — poll scan progress
router.get('/scan/:id/status', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const scan = dbQueries.getScan(id);

  if (!scan) {
    res.status(404).json({ error: `Scan ${id} not found` });
    return;
  }

  res.json(scan);
});

// GET /scan/:id/results — flagged links grouped by status
router.get('/scan/:id/results', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const scan = dbQueries.getScan(id);

  if (!scan) {
    res.status(404).json({ error: `Scan ${id} not found` });
    return;
  }

  const flaggedLinks = dbQueries.getFlaggedLinks(id);

  const grouped = {
    broken:        flaggedLinks.filter((l) => l.link_status === 'broken'),
    takeover_risk: flaggedLinks.filter((l) => l.link_status === 'takeover_risk'),
    unclear:       flaggedLinks.filter((l) => l.link_status === 'unclear'),
  };

  res.json({
    scan,
    summary: {
      total_links:   scan.total_links,
      flagged_count: scan.flagged_count,
      broken:        grouped.broken.length,
      takeover_risk: grouped.takeover_risk.length,
      unclear:       grouped.unclear.length,
    },
    flagged_links: grouped,
  });
});

// GET /scan/post/:postId/debug — fetch post from Ghost and show extracted links (no scanning)
router.get('/scan/post/:postId/debug', async (req: Request, res: Response) => {
  if (!process.env.GHOST_KEY) {
    res.status(500).json({ error: 'GHOST_KEY environment variable is not set' });
    return;
  }

  try {
    const { fetchPost } = await import('./ghost');
    const { load } = await import('cheerio');

    const post = await fetchPost(req.params.postId, process.env.GHOST_KEY);

    const links: string[] = [];
    const allHrefs: string[] = [];

    if (post.html) {
      const $ = load(post.html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') ?? '';
        allHrefs.push(href);
        if (href.startsWith('http://') || href.startsWith('https://')) {
          links.push(href);
        }
      });
    }

    const unique = [...new Set(links)];

    res.json({
      post_id:       post.id,
      post_title:    post.title,
      post_url:      post.url,
      html_length:   post.html?.length ?? 0,
      all_hrefs:     allHrefs,
      http_links:    links,
      unique_links:  unique,
      unique_count:  unique.length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// GET /scans — list 20 most recent scans
router.get('/scans', (_req: Request, res: Response) => {
  res.json(dbQueries.listScans());
});

// GET /health
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// GET /dashboard — serve the dashboard UI
router.get('/dashboard', (_req: Request, res: Response) => {
  res.sendFile(path.resolve(__dirname, 'dashboard.html'));
});

// GET /flagged-links — all flagged links (for dashboard)
router.get('/flagged-links', (_req: Request, res: Response) => {
  res.json(dbQueries.getAllFlaggedLinks());
});

// PATCH /flagged-links/:id — set resolution ('resolved' | 'invalid' | null)
router.patch('/flagged-links/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const { resolution } = req.body as { resolution: 'resolved' | 'invalid' | null };

  if (resolution !== 'resolved' && resolution !== 'invalid' && resolution !== null) {
    res.status(400).json({ error: 'resolution must be "resolved", "invalid", or null' });
    return;
  }

  const link = dbQueries.getFlaggedLink(id);
  if (!link) {
    res.status(404).json({ error: `Flagged link ${id} not found` });
    return;
  }

  dbQueries.setResolution(id, resolution);
  res.json({ ...link, resolution });
});

// ── Mount at both / and /linkchecker ─────────────────────────────────────────
// Handles direct access and reverse-proxy setups that strip or preserve the prefix.

app.use('/', router);
app.use('/linkchecker', router);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  await openDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🔗 Link Scanner API — http://0.0.0.0:${PORT}\n`);
    console.log('  Both /scan/... and /linkchecker/scan/... work\n');
    console.log('  POST   /[linkchecker/]scan/trigger          full blog scan');
    console.log('  POST   /[linkchecker/]scan/post/:postId     single post scan');
    console.log('  GET    /[linkchecker/]scan/:id/status       poll progress');
    console.log('  GET    /[linkchecker/]scan/:id/results      flagged links');
    console.log('  GET    /[linkchecker/]scans                 recent scans');
    console.log('  GET    /[linkchecker/]health                health check\n');
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});

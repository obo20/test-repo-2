import axios from 'axios';

export interface GhostPost {
  id: string;
  title: string;
  url: string;
  html: string | null;
}

interface GhostResponse {
  posts: GhostPost[];
  meta: {
    pagination: {
      page: number;
      pages: number;
      limit: number;
      total: number;
      next: number | null;
      prev: number | null;
    };
  };
}

const BASE_URL = 'https://pinata.ghost.io/blog/ghost/api/content/posts';

// Shared config for all Ghost API requests.
// maxRedirects: 10 handles Ghost's 301s (e.g. trailing-slash normalisation,
// http→https, subdomain redirects) without throwing.
const GHOST_AXIOS_CONFIG = {
  timeout: 30_000,
  maxRedirects: 10,
};

export async function fetchPost(id: string, apiKey: string): Promise<GhostPost> {
  const { data } = await axios.get<{ posts: GhostPost[] }>(`${BASE_URL}/${id}`, {
    ...GHOST_AXIOS_CONFIG,
    params: {
      key: apiKey,
      fields: 'id,title,url',
      formats: 'html',
    },
  });

  const post = data.posts[0];
  if (!post) throw new Error(`Post "${id}" not found`);
  return post;
}

/**
 * Fetches ALL post metadata (id, title, url) across all pages.
 * HTML is intentionally excluded here — responses stay small and pagination
 * is reliable. HTML is fetched per-post during scanning via fetchPost().
 */
export async function fetchAllPosts(apiKey: string): Promise<GhostPost[]> {
  const allPosts: GhostPost[] = [];
  let currentPage = 1;
  let hasMore = true;

  while (hasMore) {
    console.log(`  → Fetching posts page ${currentPage}…`);

    const { data } = await axios.get<GhostResponse>(BASE_URL, {
      ...GHOST_AXIOS_CONFIG,
      params: {
        key: apiKey,
        fields: 'id,title,url',
        limit: 15,
        page: currentPage,
      },
    });

    allPosts.push(...data.posts);

    const pagination = data.meta.pagination;
    console.log(`  → Page ${currentPage}/${pagination.pages} — ${data.posts.length} posts fetched`);

    if (pagination.next === null || pagination.next === undefined) {
      hasMore = false;
    } else {
      currentPage = pagination.next;
    }
  }

  console.log(`  → Total posts fetched: ${allPosts.length}`);
  return allPosts;
}

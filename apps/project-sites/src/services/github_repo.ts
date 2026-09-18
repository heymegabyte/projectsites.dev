/**
 * @module services/github_repo
 *
 * GitHub Repository sync — every projectsites.dev site gets a private GitHub
 * repo at github.com/{org}/{siteId} as its canonical source-of-truth.
 *
 * Operations:
 * - createRepo(siteId) — provision a private repo under the org
 * - pushBuild(siteId, files, message) — commit + push generated site files
 * - getHistory(siteId) — list commits for rollback UI
 * - rollback(siteId, commitSha) — revert to a previous commit
 *
 * Auth: GitHub fine-grained PAT or App installation token with repo scope.
 * All calls are idempotent — creating an existing repo is a no-op.
 *
 * @example
 * ```ts
 * await createRepo(env, 'abc-123-def');
 * await pushBuild(env, 'abc-123-def', files, 'feat(site): initial build');
 * const history = await getHistory(env, 'abc-123-def');
 * await rollback(env, 'abc-123-def', history[1].sha);
 * ```
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface GithubRepoConfig {
  org: string;
  token: string;
}

export interface GhCommitFile {
  path: string;
  content: string;
}

export interface GhCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

// ── Error class ─────────────────────────────────────────────────────────────

export class GithubRepoError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GithubRepoError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function config(env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string }): GithubRepoConfig {
  const org = env.GITHUB_ORG || 'projectsites-dev';
  const token = env.GITHUB_REPO_TOKEN;
  if (!token) throw new GithubRepoError('GITHUB_REPO_TOKEN is not configured', 'MISSING_TOKEN');
  return { org, token };
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'projectsites-dev/1.0',
  };
}

// ── createRepo ──────────────────────────────────────────────────────────────

/**
 * Creates a private GitHub repository named `{siteId}` under the configured org.
 *
 * Idempotent — if the repo already exists (422), returns the existing repo URL
 * without error. Throws on auth failures and permission errors.
 *
 * @returns The repo's HTTPS clone URL.
 */
export async function createRepo(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
): Promise<string> {
  const { org, token } = config(env);
  const url = `https://api.github.com/orgs/${org}/repos`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: siteId,
      private: true,
      description: `ProjectSites.dev site — ${siteId}`,
      auto_init: false,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (res.status === 201) {
    return body.html_url as string;
  }

  if (
    res.status === 422 &&
    (body.errors as Array<{ message: string }>)?.some((e) => e.message?.includes('already exists'))
  ) {
    // Repo exists — fetch its URL
    const getRes = await fetch(`https://api.github.com/repos/${org}/${siteId}`, {
      headers: apiHeaders(token),
    });
    if (getRes.ok) {
      const getBody = (await getRes.json()) as Record<string, unknown>;
      return getBody.html_url as string;
    }
  }

  throw new GithubRepoError(
    `Failed to create repo: ${res.status} ${JSON.stringify(body)}`,
    'CREATE_FAILED',
    res.status,
  );
}

// ── pushBuild ───────────────────────────────────────────────────────────────

/**
 * Commits and pushes generated site files to the GitHub repo.
 *
 * Workflow:
 * 1. GET /repos/{org}/{repo}/git/ref/heads/main → get latest commit SHA
 * 2. POST /repos/{org}/{repo}/git/trees → create tree from files
 * 3. POST /repos/{org}/{repo}/git/commits → create commit
 * 4. PATCH /repos/{org}/{repo}/git/refs/heads/main → update ref
 *
 * This is the low-level Git Data API path — no working tree, no clone, just
 * direct tree/commit/ref manipulation. Each build = one commit.
 */
export async function pushBuild(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
  files: GhCommitFile[],
  message: string,
): Promise<GhCommit> {
  const { org, token } = config(env);
  const base = `https://api.github.com/repos/${org}/${siteId}`;

  // 1. Get latest commit on main (or create initial commit for empty repos)
  let parentSha: string;
  const refRes = await fetch(`${base}/git/ref/heads/main`, { headers: apiHeaders(token) });

  if (refRes.status === 404) {
    // Empty repo — create an initial empty commit
    parentSha = await createInitialCommit(base, token);
  } else if (!refRes.ok) {
    const errBody = (await refRes.json().catch(() => ({}))) as Record<string, unknown>;
    throw new GithubRepoError(`Failed to get ref: ${refRes.status}`, 'REF_FAILED', refRes.status);
  } else {
    const refBody = (await refRes.json()) as { object: { sha: string } };
    parentSha = refBody.object.sha;
  }

  // 2. Create tree
  const treeItems = files.map((f) => ({
    path: f.path,
    mode: '100644' as const,
    type: 'blob' as const,
    content: f.content,
  }));

  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: parentSha, tree: treeItems }),
  });

  if (!treeRes.ok) {
    const errBody = (await treeRes.json().catch(() => ({}))) as Record<string, unknown>;
    throw new GithubRepoError(
      `Failed to create tree: ${treeRes.status}`,
      'TREE_FAILED',
      treeRes.status,
    );
  }

  const treeBody = (await treeRes.json()) as { sha: string };
  const treeSha = treeBody.sha;

  // 3. Create commit
  const commitRes = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha],
    }),
  });

  if (!commitRes.ok) {
    const errBody = (await commitRes.json().catch(() => ({}))) as Record<string, unknown>;
    throw new GithubRepoError(
      `Failed to create commit: ${commitRes.status}`,
      'COMMIT_FAILED',
      commitRes.status,
    );
  }

  const commitBody = (await commitRes.json()) as {
    sha: string;
    html_url: string;
    author: { name: string; date: string };
    message: string;
  };

  // 4. Update ref
  const updateRes = await fetch(`${base}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: commitBody.sha, force: false }),
  });

  if (!updateRes.ok) {
    const errBody = (await updateRes.json().catch(() => ({}))) as Record<string, unknown>;
    throw new GithubRepoError(
      `Failed to update ref: ${updateRes.status}`,
      'UPDATE_REF_FAILED',
      updateRes.status,
    );
  }

  return {
    sha: commitBody.sha,
    message: commitBody.message,
    author: commitBody.author?.name ?? 'projectsites-dev',
    date: commitBody.author?.date ?? new Date().toISOString(),
    url: commitBody.html_url,
  };
}

/**
 * Creates an initial empty commit for a brand-new repo that has no refs yet.
 * Pushes a .gitkeep to establish the main branch.
 */
async function createInitialCommit(base: string, token: string): Promise<string> {
  // Create a README as the initial commit to establish main branch
  const initRes = await fetch(`${base}/contents/README.md`, {
    method: 'PUT',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'chore: initial commit (ProjectSites.dev)',
      content: btoa('# Site managed by ProjectSites.dev\n'),
      branch: 'main',
    }),
  });

  if (!initRes.ok) {
    // Fallback: create an empty blob + tree + commit manually. Each step is res.ok-gated so a
    // narrow-scope token (repo-create but NOT contents:write) fails LOUD with a typed error at the
    // first failing call, instead of cascading an `undefined` `.sha` into confusing downstream
    // 422s that mask the real cause (AL-778).
    const blobRes = await fetch(`${base}/git/blobs`, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Site\n', encoding: 'utf-8' }),
    });
    if (!blobRes.ok) {
      throw new GithubRepoError(
        `Initial-commit blob create failed: ${blobRes.status}`,
        'CREATE_FAILED',
        blobRes.status,
      );
    }
    const blobBody = (await blobRes.json()) as { sha: string };

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blobBody.sha }],
      }),
    });
    if (!treeRes.ok) {
      throw new GithubRepoError(
        `Initial-commit tree create failed: ${treeRes.status}`,
        'CREATE_FAILED',
        treeRes.status,
      );
    }
    const treeBody = (await treeRes.json()) as { sha: string };

    const commitRes = await fetch(`${base}/git/commits`, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'chore: initial commit', tree: treeBody.sha, parents: [] }),
    });
    if (!commitRes.ok) {
      throw new GithubRepoError(
        `Initial-commit create failed: ${commitRes.status}`,
        'CREATE_FAILED',
        commitRes.status,
      );
    }
    const commitBody = (await commitRes.json()) as { sha: string };

    const refCreateRes = await fetch(`${base}/git/refs`, {
      method: 'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'refs/heads/main', sha: commitBody.sha }),
    });
    if (!refCreateRes.ok) {
      throw new GithubRepoError(
        `Initial-commit ref create failed: ${refCreateRes.status}`,
        'REF_FAILED',
        refCreateRes.status,
      );
    }

    return commitBody.sha;
  }

  const initBody = (await initRes.json()) as { commit: { sha: string } };
  return initBody.commit.sha;
}

// ── getHistory ──────────────────────────────────────────────────────────────

/**
 * Lists commits on the main branch — most recent first.
 * Used for the rollback UI in the admin dashboard.
 */
export async function getHistory(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
  perPage = 20,
): Promise<GhCommit[]> {
  const { org, token } = config(env);
  const url = `https://api.github.com/repos/${org}/${siteId}/commits?sha=main&per_page=${perPage}`;

  const res = await fetch(url, { headers: apiHeaders(token) });

  if (!res.ok) {
    if (res.status === 404) return []; // Repo doesn't exist yet
    throw new GithubRepoError(`Failed to get history: ${res.status}`, 'HISTORY_FAILED', res.status);
  }

  const commits = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } };
    html_url: string;
  }>;

  return commits.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? 'unknown',
    date: c.commit.author?.date ?? '',
    url: c.html_url,
  }));
}

// ── rollback ────────────────────────────────────────────────────────────────

/**
 * Rolls back to a specific commit by reverting it on main.
 *
 * Instead of `git revert` (which creates an inverse commit), this creates a
 * new commit that restores the tree state of the target commit. This is simpler
 * and avoids merge conflicts on linear histories.
 *
 * The caller should trigger a redeploy after rollback.
 */
export async function rollback(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
  targetSha: string,
): Promise<GhCommit> {
  const { org, token } = config(env);

  // Get the tree SHA of the target commit
  const commitRes = await fetch(
    `https://api.github.com/repos/${org}/${siteId}/git/commits/${targetSha}`,
    { headers: apiHeaders(token) },
  );

  if (!commitRes.ok) {
    throw new GithubRepoError(`Target commit not found: ${targetSha}`, 'COMMIT_NOT_FOUND', 404);
  }

  const commitBody = (await commitRes.json()) as {
    sha: string;
    tree: { sha: string };
    message: string;
  };
  const treeSha = commitBody.tree.sha;

  // Get current HEAD — gate on res.ok (the sole ungated fetch in this file). A GitHub 403
  // rate-limit or 404 (repo deleted between the ownership check and here, or a missing main ref)
  // would otherwise crash on `refBody.object.sha` with an opaque 502 instead of a clear typed
  // error the caller can surface + retry (AL-778).
  const refRes = await fetch(`https://api.github.com/repos/${org}/${siteId}/git/ref/heads/main`, {
    headers: apiHeaders(token),
  });
  if (!refRes.ok) {
    throw new GithubRepoError(
      `Failed to get current HEAD (main ref): ${refRes.status}`,
      'REF_FAILED',
      refRes.status,
    );
  }
  const refBody = (await refRes.json()) as { object: { sha: string } };
  const parentSha = refBody.object.sha;

  // Create a new commit with the target tree, parented on current HEAD
  const rollbackMessage = `revert: rollback to ${targetSha.slice(0, 7)}\n\nRestores site to commit ${targetSha}.`;

  const newCommitRes = await fetch(`https://api.github.com/repos/${org}/${siteId}/git/commits`, {
    method: 'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: rollbackMessage,
      tree: treeSha,
      parents: [parentSha],
    }),
  });

  if (!newCommitRes.ok) {
    throw new GithubRepoError(
      'Failed to create rollback commit',
      'ROLLBACK_FAILED',
      newCommitRes.status,
    );
  }

  const newCommitBody = (await newCommitRes.json()) as { sha: string; html_url: string };

  // Update main ref
  await fetch(`https://api.github.com/repos/${org}/${siteId}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommitBody.sha, force: false }),
  });

  return {
    sha: newCommitBody.sha,
    message: rollbackMessage,
    author: 'projectsites-dev',
    date: new Date().toISOString(),
    url: newCommitBody.html_url,
  };
}

// ── deleteRepo ──────────────────────────────────────────────────────────────

/**
 * Deletes a site's GitHub repository. Called on site deletion.
 * Requires the token to have delete_repo scope.
 */
export async function deleteRepo(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
): Promise<void> {
  const { org, token } = config(env);
  const res = await fetch(`https://api.github.com/repos/${org}/${siteId}`, {
    method: 'DELETE',
    headers: apiHeaders(token),
  });

  if (!res.ok && res.status !== 404) {
    throw new GithubRepoError(`Failed to delete repo: ${res.status}`, 'DELETE_FAILED', res.status);
  }
}

// ── repoExists ──────────────────────────────────────────────────────────────

/**
 * Checks whether a GitHub repo exists for this site.
 */
export async function repoExists(
  env: { GITHUB_ORG?: string; GITHUB_REPO_TOKEN?: string },
  siteId: string,
): Promise<boolean> {
  const { org, token } = config(env);
  const res = await fetch(`https://api.github.com/repos/${org}/${siteId}`, {
    headers: apiHeaders(token),
  });
  return res.ok;
}

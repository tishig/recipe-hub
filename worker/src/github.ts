// GitHubのファイル読み書き（Contents API）

export interface GitHubEnv {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string; // "owner/repo"
  GITHUB_BRANCH?: string;
  GITHUB_API?: string; // 試験用。通常は未設定（https://api.github.com）
}

function headers(env: GitHubEnv) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "recipe-hub-mcp",
  };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function getFile(env: GitHubEnv, path: string): Promise<{ raw: string; sha: string } | null> {
  const branch = env.GITHUB_BRANCH ?? "main";
  const res = await fetch(
    `${env.GITHUB_API ?? "https://api.github.com"}/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=${branch}`,
    { headers: headers(env) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(res.status, `GitHubからの読み込みに失敗: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { content: string; sha: string };
  return { raw: fromBase64(j.content), sha: j.sha };
}

// sha を渡すと上書き、渡さないと新規作成（すでにあれば 422 で失敗）
export async function putFile(
  env: GitHubEnv, path: string, raw: string, message: string, sha?: string,
): Promise<{ sha: string; commit: string }> {
  const res = await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { ...headers(env), "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: toBase64(raw), branch: env.GITHUB_BRANCH ?? "main", ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHubへの書き込みに失敗: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { content: { sha: string }; commit: { html_url: string } };
  return { sha: j.content.sha, commit: j.commit.html_url };
}

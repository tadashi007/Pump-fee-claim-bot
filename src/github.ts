import type { GitHubProfileRecord, JsonStorage } from "./storage";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  html_url: string;
  avatar_url: string;
  followers: number;
  following: number;
  public_repos: number;
}

interface GitHubRepoResponse {
  stargazers_count: number;
}

export class GitHubProfileService {
  constructor(
    private readonly storage: JsonStorage,
    private readonly token?: string,
  ) {}

  async getProfileByAccountId(accountId: string): Promise<GitHubProfileRecord | undefined> {
    const cached = this.storage.getGitHubProfile(accountId);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
      return cached;
    }

    try {
      const response = await this.fetchGitHub(`https://api.github.com/user/${encodeURIComponent(accountId)}`);

      if (response.status === 404) {
        return cached;
      }

      const payload = (await response.json()) as GitHubUserResponse;
      const totalRepoStars = await this.fetchTotalRepoStars(payload.login);
      const profile: GitHubProfileRecord = {
        accountId: String(payload.id),
        login: payload.login,
        name: payload.name ?? undefined,
        htmlUrl: payload.html_url,
        avatarUrl: payload.avatar_url,
        followers: payload.followers,
        following: payload.following,
        publicRepos: payload.public_repos,
        totalRepoStars,
        fetchedAt: new Date().toISOString(),
      };
      await this.storage.upsertGitHubProfile(profile);
      return profile;
    } catch (error) {
      console.warn(`GitHub lookup skipped for ${accountId}: ${toErrorSummary(error)}`);
      return cached;
    }
  }

  private async fetchTotalRepoStars(login: string): Promise<number | undefined> {
    let totalStars = 0;
    const perPage = 100;
    const maxPages = 10;

    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.fetchGitHub(
        `https://api.github.com/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&per_page=${perPage}&page=${page}`,
      );

      if (response.status === 404) {
        return undefined;
      }

      const repos = (await response.json()) as GitHubRepoResponse[];
      for (const repo of repos) {
        totalStars += repo.stargazers_count ?? 0;
      }

      if (repos.length < perPage) {
        break;
      }
    }

    return totalStars;
  }

  private async fetchGitHub(url: string): Promise<Response> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        Accept: "application/vnd.github+json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pump-fee-monitor-bot",
      },
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`GitHub lookup failed with status ${response.status}`);
    }

    return response;
  }
}

function toErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

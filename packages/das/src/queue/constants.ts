export const FETCH_QUEUE = "github-fetch";

export const FETCH_JOBS = {
  PR_METADATA: "fetch-pr-metadata",
  PR_FILES: "fetch-pr-files",
  BACKFILL_REPO: "backfill-repo",
} as const;

export const DEFAULT_BACKFILL_DAYS = 40;

export function prFilesJobId(
  repoFullName: string,
  prNumber: number,
  headSha: string | null,
  baseSha: string | null,
): string {
  return `files-${repoFullName}-${prNumber}-${headSha ?? "no-head"}-${
    baseSha ?? "no-base"
  }`;
}

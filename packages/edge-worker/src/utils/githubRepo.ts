/**
 * Splits "owner/repo" into { owner, repo }.
 */
export function parseRepoOwner(repoInput: string, ownerInput?: string): { owner: string; repo: string } {
  if (ownerInput && repoInput && !repoInput.includes('/')) {
    return { owner: ownerInput.trim(), repo: repoInput.trim() };
  }
  const parts = repoInput.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository format "${repoInput}". Expected "owner/repo".`);
  }
  return {
    owner: parts[0],
    repo: parts.slice(1).join('/')
  };
}

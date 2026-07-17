export const API_TOKEN_STORAGE_KEY = "worldtangle.api-token";

export function readApiToken(): string {
  try {
    return sessionStorage.getItem(API_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function writeApiToken(token: string): void {
  try {
    if (token.length === 0) sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
    else sessionStorage.setItem(API_TOKEN_STORAGE_KEY, token);
  } catch {
    // A locked-down browser may deny storage. The in-memory token still works.
  }
}

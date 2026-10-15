/**
 * Configuration.
 *
 * Everything here is read from the environment so a self-hosted instance works
 * without a rebuild, and so the tests can point a provider at a local mock.
 *
 * `GITHUB_CLIENT_ID` is the one value that must never be invented. An OAuth
 * App belongs to a person who registered it, and shipping a guessed one would
 * mean every Forgeline install silently authenticated as that stranger — with
 * whatever repositories their token can see. Until a real one is set, sign-in
 * is offered but disabled, and the reason given is the plain truth: no app has
 * been registered yet.
 */

export interface ProviderConfig {
  /** The OAuth App's Client ID. Empty means "not configured", which is a
   *  supported state, not an error. */
  clientId: string;
  /** Base URL of the API, without a trailing slash. Overridable so the device
   *  flow can be tested against a local mock, and so a self-hosted instance
   *  works. */
  apiBaseUrl: string;
  /** Where the user goes to enter the code. Also overridable for tests. */
  deviceUrl: string;
  /** Scope the device-code request asks for. `repo` is what push, pull, and
   *  creating a release or pull request need. */
  scope: string;
}

function trimmed(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const GITHUB_DEFAULT_API = "https://github.com";
export const GITHUB_DEFAULT_DEVICE_URL = "https://github.com/login/device";

export const githubConfig = (): ProviderConfig => ({
  clientId: trimmed(process.env.GITHUB_CLIENT_ID),
  apiBaseUrl: stripTrailingSlash(trimmed(process.env.GITHUB_BASE_URL, GITHUB_DEFAULT_API)),
  deviceUrl: stripTrailingSlash(trimmed(process.env.GITHUB_DEVICE_URL, GITHUB_DEFAULT_DEVICE_URL)),
  scope: trimmed(process.env.GITHUB_SCOPE, "repo"),
});

/** Whether sign-in can be attempted at all. False is normal and expected until
 *  someone registers an app; the interface explains it rather than hiding it. */
export function githubConfigured(): boolean {
  return githubConfig().clientId.length > 0;
}

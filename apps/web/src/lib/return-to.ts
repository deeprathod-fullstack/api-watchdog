/**
 * The `returnTo` query parameter, treated as hostile input.
 *
 * A login screen that navigates to whatever `returnTo` says is an open
 * redirect: `/login?returnTo=https://evil.example/login` renders a convincing
 * phishing page one click after a real sign-in, on a link that genuinely came
 * from us. So the value is not sanitised, it is *validated* — anything that is
 * not a plain internal path is discarded and the caller falls back to the
 * dashboard.
 */
const FALLBACK = '/';

/**
 * Accept only a path rooted at this origin.
 *
 * Rejected, in order: anything not starting with `/` (relative paths and
 * absolute URLs with a scheme); `//host` and `/\host`, which browsers resolve
 * as protocol-relative URLs to another origin; and control characters, which
 * have historically been used to smuggle a scheme past exactly this kind of
 * check.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return FALLBACK;

  if (!raw.startsWith('/')) return FALLBACK;
  if (hasControlCharacter(raw)) return FALLBACK;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return FALLBACK;

  return raw;
}

/**
 * True if the string contains a C0/C7 control character.
 *
 * Written as a code-point scan rather than a regex literal so the characters
 * being rejected never have to appear in this source file.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Build the login URL that will send the user back where they were headed. */
export function loginPathWithReturnTo(
  loginPath: string,
  destination: string,
): string {
  if (safeReturnTo(destination) === FALLBACK) return loginPath;

  return `${loginPath}?returnTo=${encodeURIComponent(destination)}`;
}

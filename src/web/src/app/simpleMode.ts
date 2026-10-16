const KEY = "forgeline-simple";

/**
 * Simple mode, stored on this computer like every other display preference.
 *
 * `localStorage` can throw — a blocked store, private mode, a WebView with no
 * storage — so every path falls back to a working answer instead of failing a
 * render. The default is off: starting someone in a reduced interface they did
 * not ask for is a guess, and this app's whole premise is not making them.
 */
export function loadSimpleMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function saveSimpleMode(value: boolean): void {
  try {
    localStorage.setItem(KEY, value ? "on" : "off");
  } catch {
    // Writing is best-effort; the read above already degrades the same way.
  }
  // A reload is enough, and it is the honest way to add a mode that changes
  // which screens are on screen at all: re-rendering it would be a page that
  // is briefly two different interfaces.
  window.location.reload();
}

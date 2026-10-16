import { readJson, writeJson } from "./appdata.js";

/**
 * Per-repository sticky notes.
 *
 * Stored in the app's data folder, never inside the repository — the spec is
 * explicit about this, and the reason is not politeness: a note written into a
 * user's working tree would show up in their next `git status`, get committed
 * by accident, and be exactly the kind of surprise the app promises not to
 * produce. The key is the repository path, so the same folder has the same
 * note wherever it is opened from.
 */

export interface Note {
  repo: string;
  text: string;
  updatedAt: string;
}

interface NoteStore {
  notes: Note[];
}

const FILE = "notes.json";

/**
 * `appdata` already handles the read-only-home and no-home cases, so the notes
 * reuse it rather than opening the file a second way. A read that fails is a
 * store with nothing in it, which is the honest state of a fresh install.
 */
async function readStore(): Promise<NoteStore> {
  const parsed = await readJson<NoteStore>(FILE);
  // A file that is not the expected shape is treated as empty rather than
  // trusted: a corrupt notes file must cost the notes and nothing else.
  if (parsed === undefined || !Array.isArray(parsed.notes)) return { notes: [] };
  return parsed;
}

async function writeStore(store: NoteStore): Promise<void> {  await writeJson(FILE, store);
}

/** The note for one repository, or an empty string when there is none. */
export async function readNote(repoPath: string): Promise<string> {
  const store = await readStore();
  // The latest write wins, so a stale duplicate cannot resurrect old text.
  return store.notes.filter((note) => note.repo === repoPath).sort(byNewest)[0]?.text ?? "";
}

export async function writeNote(repoPath: string, text: string): Promise<void> {  const store = await readStore();
  const kept = store.notes.filter((note) => note.repo !== repoPath);
  // An empty note is no note: keeping it would leave a query asking about a
  // repository that has one and getting an empty string back.
  if (text.trim().length > 0) {
    kept.push({ repo: repoPath, text, updatedAt: new Date().toISOString() });
  }
  await writeStore({ notes: kept });
}

const byNewest = (a: Note, b: Note) => b.updatedAt.localeCompare(a.updatedAt);

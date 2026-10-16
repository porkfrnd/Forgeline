import { useEffect, useMemo, useState } from "react";

export interface PaletteAction {
  id: string;
  label: string;
  group: string;
  /** Short keycap hint shown on the right. */
  keys?: string;
  run: () => void;
}

interface CommandPaletteProps {
  actions: PaletteAction[];
}

/**
 * The command palette: Ctrl or Cmd + K.
 *
 * Grouped results, keycap hints, and a recent section. It only lists actions
 * that actually run something — the slot rule applies here as much as it does
 * to the toolbar.
 */
export function CommandPalette({ actions }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      const recentSet = new Set(recent);
      const recentActions = recent
        .map((id) => actions.find((a) => a.id === id))
        .filter((a): a is PaletteAction => Boolean(a));
      const rest = actions.filter((a) => !recentSet.has(a.id));
      return [...recentActions, ...rest];
    }
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query, recent]);

  const grouped = useMemo(() => {
    const out = new Map<string, PaletteAction[]>();
    for (const action of results) {
      const list = out.get(action.group) ?? [];
      list.push(action);
      out.set(action.group, list);
    }
    return [...out.entries()];
  }, [results]);

  const commit = (action: PaletteAction) => {
    setRecent((cur) => [action.id, ...cur.filter((id) => id !== action.id)].slice(0, 5));
    action.run();
    setOpen(false);
  };

  if (!open) return null;

  return (
    <div className="palette-overlay" role="presentation" onClick={() => setOpen(false)}>
      <div
        className="palette panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="palette-input"
          value={query}
          autoFocus
          placeholder="Type a command"
          aria-label="Command"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) commit(results[0]);
          }}
        />
        <div className="palette-results" role="listbox" aria-label="Commands">
          {grouped.length === 0 ? (
            <p className="message muted palette-empty">Nothing matches that.</p>
          ) : (
            grouped.map(([group, list]) => (
              <section key={group} className="palette-group">
                <p className="label">{group}</p>
                {list.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="row palette-item"
                    onClick={() => commit(action)}
                  >
                    <span>{action.label}</span>
                    <span className="spacer" />
                    {action.keys ? <kbd className="keycap">{action.keys}</kbd> : null}
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
        <p className="palette-hint">
          <kbd className="keycap">Enter</kbd> run <kbd className="keycap">Esc</kbd> close
        </p>
      </div>
    </div>
  );
}

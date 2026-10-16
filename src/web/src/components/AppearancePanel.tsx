import { useEffect, useRef, type RefObject } from "react";
import { loadSimpleMode, saveSimpleMode } from "../app/simpleMode";
import { FAMILIES, visibleFamilies, type Mode } from "../theme/families";
import { useTheme, type Density, type Effects, type Surface } from "../theme/ThemeProvider";

interface AppearancePanelProps {
  /** Closed when this ref is clicked outside of. */
  closeRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Simple mode is a display preference, so it lives with the other ones rather
 * than in a separate place a person has to know to look. It is kept on this
 * computer and is never a guess about who the user is.
 */

/**
 * Appearance: family, mode, surface, effects, density.
 *
 * Family and mode are separate controls. A family that cannot do the chosen
 * mode disables that mode and says why, rather than offering a broken one.
 */
export function AppearancePanel({ closeRef, onClose }: AppearancePanelProps) {
  const { appearance, familyLabel, modeUnavailable, set } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (closeRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [closeRef, onClose]);

  const family = FAMILIES.find((f) => f.id === appearance.family) ?? FAMILIES[0];
  const modeChoice = appearance.mode;
  const modes: (Mode | "auto")[] = ["auto", "dark", "light"];
  const simple = loadSimpleMode();

  return (
    <div
      className="panel appearance"
      role="dialog"
      aria-label="Appearance"
      ref={panelRef}
    >
      <p className="label">Theme family</p>
      <div className="control-grid">
        {visibleFamilies().map((f) => (
          <button
            key={f.id}
            type="button"
            className="button"
            aria-pressed={f.id === appearance.family}
            onClick={() => set({ family: f.id })}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="label">Mode</p>
      <div className="control-grid">
        {modes.map((m) => {
          const supported = m === "auto" || family.modes.includes(m);
          const unavailableReason = supported
            ? null
            : `${family.label} has no ${m} mode, so ${m} is disabled.`;
          return (
            <button
              key={m}
              type="button"
              className="button"
              disabled={!supported}
              aria-pressed={m === modeChoice}
              title={unavailableReason ?? undefined}
              onClick={() => set({ mode: m })}
            >
              {m === "auto" ? "Auto" : m === "dark" ? "Dark" : "Light"}
            </button>
          );
        })}
      </div>
      {modeUnavailable ? (
        <p className="live-note">
          {familyLabel} has no {modeChoice} mode, so the nearest available one is shown.
        </p>
      ) : null}

      <p className="label">Surface</p>
      <div className="control-grid">
        {(["glass", "solid"] as Surface[]).map((s) => (
          <button
            key={s}
            type="button"
            className="button"
            aria-pressed={s === appearance.surface}
            onClick={() => set({ surface: s })}
          >
            {s === "glass" ? "Glass" : "Solid"}
          </button>
        ))}
      </div>

      <p className="label">Effects</p>
      <div className="control-grid">
        {(["full", "reduced", "off"] as Effects[]).map((e) => (
          <button
            key={e}
            type="button"
            className="button"
            aria-pressed={e === appearance.effects}
            title={
              e === "off"
                ? "Off removes all motion, glow, blur, and grain. Every screen stays complete."
                : undefined
            }
            onClick={() => set({ effects: e })}
          >
            {e === "full" ? "Full" : e === "reduced" ? "Reduced" : "Off"}
          </button>
        ))}
      </div>

      <p className="label">Density</p>
      <div className="control-grid">
        {(["compact", "cozy"] as Density[]).map((d) => (
          <button
            key={d}
            type="button"
            className="button"
            aria-pressed={d === appearance.density}
            onClick={() => set({ density: d })}
          >
            {d === "compact" ? "Compact" : "Cozy"}
          </button>
        ))}
      </div>
      <p className="label">Interface</p>
      <div className="control-grid">
        <button
          type="button"
          className="button"
          aria-pressed={simple}
          title={
            simple
              ? "Turn off to see branches, staging, and the graph again."
              : "Two buttons — Save and Send — and plain wording. Nothing becomes unreachable."
          }
          onClick={() => saveSimpleMode(!simple)}
        >
          {simple ? "Simple mode: on" : "Simple mode: off"}
        </button>
      </div>
      <p className="live-note">
        {simple
          ? "Simple mode is on. Branches, staging, and the graph stay out of the way; every one of them is still a button away."
          : "Simple mode is off. Turning it on leaves Save and Send on screen, and everything else one click away."}
      </p>
    </div>
  );
}

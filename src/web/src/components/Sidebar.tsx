export function Sidebar() {
  return (
    <aside className="sidebar" aria-label="Repositories">
      <p className="empty-title">Repositories</p>
      <p className="empty-text">No folders scanned yet.</p>
      <button className="button">Choose folders</button>
    </aside>
  );
}

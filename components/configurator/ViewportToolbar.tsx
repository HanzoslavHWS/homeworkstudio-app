type ViewportToolbarProps = {
  zoomPercent: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onReset: () => void;
};

export function ViewportToolbar({
  zoomPercent,
  onZoomOut,
  onZoomIn,
  onFit,
  onReset,
}: ViewportToolbarProps) {
  return (
    <div className="viewportToolbar" aria-label="Ovládání pohledu">
      <button type="button" onClick={onZoomOut} aria-label="Oddálit">−</button>
      <span>{zoomPercent} %</span>
      <button type="button" onClick={onZoomIn} aria-label="Přiblížit">+</button>
      <button type="button" onClick={onFit}>Fit</button>
      <button type="button" onClick={onReset}>100 %</button>
    </div>
  );
}

type ConfiguratorHelpProps = {
  open: boolean;
  onClose: () => void;
};

const shortcuts = [
  ["Ctrl + kolečko myši", "Zoom"],
  ["Prostřední tlačítko + tah", "Posun pohledu"],
  ["Space + levé tlačítko + tah", "Posun pohledu"],
  ["Levé tlačítko + tah na objektu", "Přesun objektu"],
  ["Klik na objekt", "Výběr objektu"],
  ["Fit", "Přizpůsobit celý stánek pohledu"],
  ["100 %", "Vrátit zoom na 100 %"],
] as const;

function CloseIcon() {
  return (
    <svg className="helpCloseIcon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function ConfiguratorHelp({ open, onClose }: ConfiguratorHelpProps) {
  if (!open) {
    return null;
  }

  return (
    <aside
      id="configurator-help"
      className="configuratorHelp"
      aria-label="Ovládání konfigurátoru"
    >
      <div className="configuratorHelpHeader">
        <div>
          <span>NÁPOVĚDA</span>
          <strong>Ovládání</strong>
        </div>
        <button
          type="button"
          className="configuratorHelpClose"
          onClick={onClose}
          aria-label="Zavřít nápovědu"
          title="Zavřít"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="configuratorHelpList">
        {shortcuts.map(([control, description]) => (
          <div className="configuratorHelpRow" key={control}>
            <kbd>{control}</kbd>
            <span>{description}</span>
          </div>
        ))}
      </div>

      <div className="configuratorHelpLegend">
        <strong>Význam zobrazení</strong>
        <div>
          <span className="legendBox legendConstruction" />
          Plný prvek – podlaha / stěny
        </div>
        <div>
          <span className="legendBox legendOverhead" />
          Čárkovaný / šrafovaný – horní konstrukce
        </div>
        <div>
          <span className="legendBox legendComponent" />
          Mobiliář
        </div>
        <div>
          <span className="legendBox legendSelected" />
          Vybraný objekt
        </div>
      </div>
    </aside>
  );
}

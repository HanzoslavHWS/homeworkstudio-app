import type {
  RequirementStatus,
  TechnicalRequirements,
} from "../../domain/project";

const statusOptions: readonly { value: RequirementStatus; label: string }[] = [
  { value: "unspecified", label: "Neuvedeno" },
  { value: "notWanted", label: "Zákazník nechce" },
  { value: "inquire", label: "Poptat" },
  { value: "ordered", label: "Zákazník chce / objednáno" },
  { value: "dataReceived", label: "Máme data" },
  { value: "ready", label: "Připraveno" },
];

export const requirementStatusLabels = Object.fromEntries(
  statusOptions.map((option) => [option.value, option.label]),
) as Record<RequirementStatus, string>;

type Props = {
  value: TechnicalRequirements;
  onChange: (value: TechnicalRequirements) => void;
  readOnly?: boolean;
};

export function TechnicalRequirementsEditor({ value, onChange, readOnly }: Props) {
  const keys = ["electricity", "water", "waste", "fasciaGraphics", "fullWrapGraphics"] as const;
  const labels = {
    electricity: "Elektřina",
    water: "Voda",
    waste: "Odpad",
    fasciaGraphics: "Grafika – límec",
    fullWrapGraphics: "Grafika – celopolep",
  };

  return (
    <div className="technicalRequirements">
      {keys.map((key) => {
        const requirement = value[key];
        return (
          <div className="technicalRequirement" key={key}>
            <strong>{labels[key]}</strong>
            <select
              value={requirement.status}
              disabled={readOnly}
              onChange={(event) =>
                onChange({
                  ...value,
                  [key]: { ...requirement, status: event.target.value as RequirementStatus },
                })
              }
            >
              {statusOptions.filter((option) =>
                ["fasciaGraphics", "fullWrapGraphics"].includes(key) || !["dataReceived", "ready"].includes(option.value),
              ).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {key === "electricity" && (
              <div className="powerRequirement">
                <select
                  value={value.electricity.powerOption}
                  disabled={readOnly}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      electricity: {
                        ...value.electricity,
                        powerOption: event.target.value as typeof value.electricity.powerOption,
                      },
                    })
                  }
                >
                  <option value="">Výkon neuveden</option>
                  <option value="2kw">2 kW</option>
                  <option value="3kw">3 kW</option>
                  <option value="5kw">5 kW</option>
                  <option value="9kw">9 kW</option>
                  <option value="custom">Vlastní</option>
                </select>
                {value.electricity.powerOption === "custom" && (
                  <input
                    value={value.electricity.customPower}
                    disabled={readOnly}
                    placeholder="Vlastní výkon"
                    onChange={(event) =>
                      onChange({
                        ...value,
                        electricity: {
                          ...value.electricity,
                          customPower: event.target.value,
                        },
                      })
                    }
                  />
                )}
              </div>
            )}
            <input
              value={requirement.note}
              disabled={readOnly}
              placeholder="Poznámka"
              onChange={(event) =>
                onChange({
                  ...value,
                  [key]: { ...requirement, note: event.target.value },
                })
              }
            />
          </div>
        );
      })}
      <div className="technicalRequirement">
        <strong>Úklid</strong>
        <select value={value.cleaning.status} disabled={readOnly} onChange={(event) => onChange({ ...value, cleaning: { ...value.cleaning, status: event.target.value as typeof value.cleaning.status } })}>
          <option value="unspecified">Neuvedeno</option><option value="notWanted">Nechtějí</option><option value="inquire">Poptat</option><option value="oneTime">Chtějí jednorázový</option><option value="daily">Chtějí denní</option>
        </select>
        {value.cleaning.status === "daily" && <input type="number" min={1} value={value.cleaning.dayCount ?? ""} disabled={readOnly} placeholder="Počet dnů (pokud je známý)" onChange={(event) => onChange({ ...value, cleaning: { ...value.cleaning, dayCount: event.target.value ? Number(event.target.value) : undefined } })} />}
        <input value={value.cleaning.note} disabled={readOnly} placeholder="Poznámka" onChange={(event) => onChange({ ...value, cleaning: { ...value.cleaning, note: event.target.value } })} />
      </div>
      <div className="technicalRequirement">
        <strong>Kontejner</strong>
        <select value={value.container.status} disabled={readOnly} onChange={(event) => onChange({ ...value, container: { ...value.container, status: event.target.value as typeof value.container.status } })}>
          <option value="unspecified">Neuvedeno</option><option value="notWanted">Nechce</option><option value="inquire">Poptat</option><option value="wanted">Chtějí</option>
        </select>
        <input value={value.container.volumeSize} disabled={readOnly} placeholder="Objem / velikost" onChange={(event) => onChange({ ...value, container: { ...value.container, volumeSize: event.target.value } })} />
        <input type="number" min={0} value={value.container.individualPriceNet ?? ""} disabled={readOnly} placeholder="Individuální cena bez DPH" onChange={(event) => onChange({ ...value, container: { ...value.container, individualPriceNet: event.target.value ? Number(event.target.value) : undefined } })} />
        <input value={value.container.note} disabled={readOnly} placeholder="Poznámka" onChange={(event) => onChange({ ...value, container: { ...value.container, note: event.target.value } })} />
      </div>
    </div>
  );
}

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
  const keys = ["electricity", "water", "waste", "graphics"] as const;
  const labels = {
    electricity: "Elektřina",
    water: "Voda",
    waste: "Odpad",
    graphics: "Grafika",
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
                key === "graphics" || !["dataReceived", "ready"].includes(option.value),
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
    </div>
  );
}

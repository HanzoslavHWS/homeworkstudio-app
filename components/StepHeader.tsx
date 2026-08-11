type StepHeaderProps = {
  currentStep: number;
  onStepSelect?: (step: number) => void;
  onSave?: () => void;
  saveStatus?: string;
};

const steps = ["Projekt", "Konfigurátor", "Vizualizace", "Souhrn", "Export"];

export function StepHeader({ currentStep, onStepSelect, onSave, saveStatus }: StepHeaderProps) {
  return (
    <header className="topbar">
      <div>
        <span className="sectionLabel">BOOTH GENERATOR</span>
      </div>

      <div className="topbarActions">
        <div className="steps">
          {steps.map((label, index) => {
            const stepNumber = index + 1;
            return (
              <Fragment key={label}>
                {index > 0 && <div className="stepLine" />}
                <button
                  type="button"
                  className={currentStep >= stepNumber ? "step active" : "step"}
                  onClick={() => onStepSelect?.(stepNumber)}
                >
                  <span>{stepNumber}</span>
                  {label}
                </button>
              </Fragment>
            );
          })}
        </div>

        {onSave && (
          <button type="button" className="saveProjectButton" onClick={onSave}>
            {saveStatus || "Uložit projekt"}
          </button>
        )}

        <form action="/api/auth/logout" method="post">
          <button type="submit" className="logoutButton">
            Odhlásit
          </button>
        </form>
      </div>
    </header>
  );
}
import { Fragment } from "react";

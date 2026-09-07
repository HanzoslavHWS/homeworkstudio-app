type StepHeaderProps = {
  currentStep: number;
  onStepSelect?: (step: number) => void;
  onSave?: () => void;
  saveStatus?: string;
  saveError?: string;
  /** The 1–5 Projekt/Konfigurátor/Vizualizace/Souhrn/Export stepper belongs only to the Booth Generator wizard itself — every other workspace section (Tiskové plochy, E-maily, admin pages, ...) keeps this header for its shared/global chrome (logout, ...) but never shows this wizard-specific stepper. Defaults to true so any caller that doesn't pass it keeps today's behavior. */
  showStepper?: boolean;
};

const steps = ["Projekt", "Konfigurátor", "Vizualizace", "Souhrn", "Export"];

export function StepHeader({ currentStep, onStepSelect, onSave, saveStatus, saveError, showStepper = true }: StepHeaderProps) {
  return (
    <header className="topbar">
      <div>
        <span className="sectionLabel">BOOTH GENERATOR</span>
      </div>

      <div className="topbarActions">
        {showStepper && (
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
        )}

        {onSave && (
          <div className="saveProjectGroup">
            <button type="button" className="saveProjectButton" onClick={onSave}>
              {saveStatus || "Uložit projekt"}
            </button>
            {saveError && <small className="uploadError">{saveError}</small>}
          </div>
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

type StepHeaderProps = {
  currentStep: number;
};

const steps = ["Projekt", "Stánek", "Konfigurace", "Vizualizace", "Export"];

export function StepHeader({ currentStep }: StepHeaderProps) {
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
                <div className={currentStep >= stepNumber ? "step active" : "step"}>
                  <span>{stepNumber}</span>
                  {label}
                </div>
              </Fragment>
            );
          })}
        </div>

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

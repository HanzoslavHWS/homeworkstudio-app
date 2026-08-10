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
    </header>
  );
}
import { Fragment } from "react";

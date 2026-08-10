import type { PlacedComponent, RotationControlMode } from "../../domain/models";

type RotationNavigatorProps = {
  component: PlacedComponent;
  onQuickAngle: (angle: number) => void;
  onRotationChange: (angle: number) => void;
  onModeChange: (mode: RotationControlMode) => void;
};

export function RotationNavigator({
  component,
  onQuickAngle,
  onRotationChange,
  onModeChange,
}: RotationNavigatorProps) {
  const { rotation } = component;

  return (
    <div className="rotationNavigator">
      <div className="rotationNavigatorTitle">
        <span>ROTACE</span>
        <strong>{component.rotationDeg}°</strong>
      </div>

      {rotation.locked ? (
        <div className="rotationLocked">Rotace zamčena</div>
      ) : (
        <>
          <div className="stepRotation quickAngles">
            {rotation.quickAngles.map((angle) => (
              <button
                key={angle}
                className={component.rotationDeg === angle ? "active" : ""}
                onClick={() => onQuickAngle(angle)}
              >
                {angle}°
              </button>
            ))}
          </div>

          {rotation.allowFreeRotation && (
            <div className="rotationModeSwitch">
              <button
                className={component.rotationMode === "snap" ? "active" : ""}
                onClick={() => onModeChange("snap")}
              >
                Rychlé úhly
              </button>
              <button
                className={component.rotationMode === "free" ? "active" : ""}
                onClick={() => onModeChange("free")}
              >
                Volná rotace
              </button>
            </div>
          )}

          {component.rotationMode === "free" && rotation.allowFreeRotation && (
            <div className="freeRotation">
              <button onClick={() => onRotationChange(component.rotationDeg - 5)}>
                −5°
              </button>
              <input
                aria-label="Volná rotace"
                className="rotationSlider"
                type="range"
                min="0"
                max="359"
                step="1"
                value={component.rotationDeg}
                onChange={(event) => onRotationChange(Number(event.target.value))}
              />
              <button onClick={() => onRotationChange(component.rotationDeg + 5)}>
                +5°
              </button>
              <input
                aria-label="Úhel rotace"
                className="rotationNumber"
                type="number"
                min="0"
                max="359"
                value={component.rotationDeg}
                onChange={(event) => onRotationChange(Number(event.target.value))}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

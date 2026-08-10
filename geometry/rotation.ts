import type {
  RotationControlMode,
  RotationPolicy,
} from "../domain/models.ts";

export function normalizeAngle(angle: number): number {
  const rounded = Math.round(angle);
  return ((rounded % 360) + 360) % 360;
}

export function rotationForMode(
  policy: RotationPolicy,
  mode: RotationControlMode,
  requestedAngle: number,
  currentAngle: number,
): number {
  if (policy.locked) {
    return normalizeAngle(currentAngle);
  }

  const normalized = normalizeAngle(requestedAngle);

  if (mode === "snap") {
    return normalizeAngle(
      Math.round(normalized / policy.snapStep) * policy.snapStep,
    );
  }

  return policy.allowFreeRotation ? normalized : normalizeAngle(currentAngle);
}

export function quickRotation(
  policy: RotationPolicy,
  requestedAngle: number,
  currentAngle: number,
): number {
  if (policy.locked) {
    return normalizeAngle(currentAngle);
  }

  const normalized = normalizeAngle(requestedAngle);
  return policy.quickAngles.includes(normalized)
    ? normalized
    : normalizeAngle(currentAngle);
}

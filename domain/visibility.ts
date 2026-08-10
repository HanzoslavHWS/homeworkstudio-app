export type VisibleObject = Readonly<{
  visible: boolean;
}>;

export function setVisibility<T extends VisibleObject>(
  object: T,
  visible: boolean,
): T {
  return object.visible === visible
    ? object
    : { ...object, visible };
}

export function toggleVisibility<T extends VisibleObject>(object: T): T {
  return setVisibility(object, !object.visible);
}

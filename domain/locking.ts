export type LockableObject = Readonly<{
  systemLocked: boolean;
  userLocked: boolean;
}>;

export function isObjectLocked(object: LockableObject): boolean {
  return object.systemLocked || object.userLocked;
}

export function setUserLock<T extends LockableObject>(
  object: T,
  userLocked: boolean,
): T {
  if (object.systemLocked) {
    return object;
  }

  return { ...object, userLocked };
}

export function toggleUserLock<T extends LockableObject>(object: T): T {
  return setUserLock(object, !object.userLocked);
}

export function applyUnlockedChange<T extends LockableObject>(
  object: T,
  changes: Partial<Omit<T, "systemLocked" | "userLocked">>,
): T {
  return isObjectLocked(object)
    ? object
    : { ...object, ...changes };
}

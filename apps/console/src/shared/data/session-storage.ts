const PREFIX = "platform-chat:v1:";
function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
export function readSessionValue(key: string | undefined): unknown {
  if (!key) return undefined;
  try {
    return JSON.parse(storage()?.getItem(PREFIX + key) ?? "null");
  } catch {
    return undefined;
  }
}
export function writeSessionValue(key: string | undefined, value: unknown) {
  if (!key) return;
  try {
    if (value === undefined) storage()?.removeItem(PREFIX + key);
    else storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* Disabled or full storage must not prevent editing or sending. */
  }
}
export function clearChatSession() {
  try {
    const saved = storage();
    if (!saved) return;
    for (const key of Object.keys(saved)) if (key.startsWith(PREFIX)) saved.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}

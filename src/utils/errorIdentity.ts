/** Shared diagnostic identity for merging; capture/occurrence IDs are deliberately excluded. */
let unreadableIdentity = 0;

export function errorIdentity(error: unknown): string[] {
  let unreadable = false;
  const read = (object: unknown, key: string): unknown => {
    if (object === null || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
    try { return (object as Record<string, unknown>)[key]; }
    catch { unreadable = true; return undefined; }
  };
  const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const coordinate = (value: unknown): string | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : undefined;
  const type = text(read(error, 'type')) ?? text(read(error, 'name')) ?? '';
  const message = text(read(error, 'value')) ?? text(read(error, 'message')) ?? '';
  const parts = [type, message];
  const stack = text(read(error, 'stack'));
  const evidence = read(error, 'evidence');
  const origin = read(evidence, 'stackOrigin');
  const frame = origin !== 'capture-site' && origin !== 'unavailable' && stack
    ? firstStackFrame(stack) : undefined;
  if (frame) {
    parts.push('frame', frame);
  } else {
    // Browser location is useful evidence even when CORS hides the stack.
    // Preserve legacy fields for restored/manual entries without an evidence envelope.
    const location = read(evidence, 'browserLocation');
    const source = text(read(location, 'source')) || text(read(error, 'source')) ||
      text(read(error, 'filename')) || text(read(error, 'src')) || '';
    const line = coordinate(read(location, 'line')) ?? coordinate(read(error, 'lineno')) ?? '';
    const column = coordinate(read(location, 'column')) ?? coordinate(read(error, 'colno')) ?? '';
    parts.push('location', source, line, column);
    // Unknown stack formats are still diagnostic evidence. Preserve them
    // rather than treating every unrecognized stack as the same empty frame.
    if (origin !== 'capture-site' && origin !== 'unavailable' && stack?.trim()) {
      parts.push('unparsed-stack', stack.trim());
    }
  }
  // Incomplete reads cannot establish equality: retain the event instead of
  // discarding it merely because two throwing accessors both produced blanks.
  if (unreadable) parts.push('unreadable', String(++unreadableIdentity));
  return parts;
}

function firstStackFrame(stack: string): string | undefined {
  for (const line of stack.split('\n')) {
    const frame = line.trim();
    if (frame.startsWith('at ') || /^(?:.*?@)?(?:https?:\/\/|file:\/\/|\/).+:\d+:\d+$/.test(frame)) {
      return frame;
    }
  }
  return undefined;
}

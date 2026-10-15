import { runWithoutConsoleCapture } from '../utils/consoleCaptureGuard';

interface Ownership {
  host: object;
  token: object;
  phase: 'installing' | 'active' | 'uninstalling';
}

// A realm-local, versioned WeakMap also covers this SDK's ESM/CJS copies.
// No plugin metadata or application payload is written to global properties.
const registryKey = Symbol.for('aemeath.plugin-object-ownership.v1');
const warned = new WeakSet<object>();

function registry(): WeakMap<object, Ownership> | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, registryKey);
    if (descriptor) {
      if (!('value' in descriptor)) return null;
      // Native brand check works for WeakMaps from other realms too, and does
      // not invoke a user-replaced .get property or a global accessor.
      WeakMap.prototype.get.call(descriptor.value, warned);
      return descriptor.value as WeakMap<object, Ownership>;
    }
    const value = new WeakMap<object, Ownership>();
    Object.defineProperty(globalThis, registryKey, { value });
    return value;
  } catch {
    // A conflicting registry must not allow an unsafe second installation.
    return null;
  }
}

function warn(plugin: object): void {
  if (warned.has(plugin)) return;
  warned.add(plugin);
  try {
    runWithoutConsoleCapture(() => console.warn(
      '[Aemeath] Plugin installation rejected: this plugin object is already owned, '
      + 'or its ownership registry is unavailable. Create a separate plugin object for each Logger.',
    ));
  } catch { /* diagnostics cannot break host initialization */ }
}

export function claimPlugin(plugin: object, host: object): object | null {
  const owners = registry();
  if (!owners || WeakMap.prototype.has.call(owners, plugin)) {
    warn(plugin);
    return null;
  }
  const token = {};
  WeakMap.prototype.set.call(owners, plugin, { host, token, phase: 'installing' });
  return token;
}

export function transitionPlugin(plugin: object, host: object, phase: Ownership['phase'], token?: object): void {
  const owners = registry();
  if (!owners) return;
  const current = WeakMap.prototype.get.call(owners, plugin) as Ownership | undefined;
  if (current?.host === host && (!token || current.token === token)) current.phase = phase;
}

export function releasePlugin(plugin: object, host: object, token?: object): void {
  const owners = registry();
  if (!owners) return;
  const current = WeakMap.prototype.get.call(owners, plugin) as Ownership | undefined;
  if (current?.host === host && (!token || current.token === token)) WeakMap.prototype.delete.call(owners, plugin);
}

export function ownershipToken(plugin: object, host: object): object | null {
  const owners = registry();
  const current = owners && WeakMap.prototype.get.call(owners, plugin) as Ownership | undefined;
  return current?.host === host ? current.token : null;
}
/** Internal opt-in for resource-complete direct lifecycle implementations. */
export function adoptPlugin(plugin: object, host: object): boolean {
  return ownershipToken(plugin, host) !== null || claimPlugin(plugin, host) !== null;
}

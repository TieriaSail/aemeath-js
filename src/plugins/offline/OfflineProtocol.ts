/**
 * Cross-tab delivery deliberately uses a different physical database.
 *
 * The suffix is stable so an explicit `offlinePersistence: false` can purge
 * both generations without importing the optional coordination plugin.  The
 * v1 database is never version-upgraded by the opt-in feature, which keeps old
 * and non-opted-in tabs on the exact 2.5 storage protocol.
 */
const COORDINATED_DATABASE_SUFFIX = '-aemeath-delivery-v2';

export function coordinatedDatabaseName(legacyDbName: string): string {
  return `${legacyDbName}${COORDINATED_DATABASE_SUFFIX}`;
}

/**
 * Clear a dormant coordinated queue after validating its persistent owner.
 * Active leadership or any live record lease makes the operation fail closed;
 * the caller can retry after the owning tab has stopped.
 */
export function clearDormantCoordinatedDatabase(
  legacyDbName: string,
  namespace: string,
  now = Date.now(),
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let missing = false;
    let settled = false;
    let abandoned = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(coordinatedDatabaseName(legacyDbName), 2);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      abandoned = true;
      finish(() => reject(new Error('coordinated IndexedDB open timed out')));
    }, 3000);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        missing = true;
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (missing) finish(() => resolve(false));
      else finish(() => reject(request.error ?? new Error('coordinated IndexedDB open failed')));
    };
    request.onblocked = () => {
      clearTimeout(timer);
      abandoned = true;
      finish(() => reject(new Error('coordinated IndexedDB open blocked')));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (abandoned) {
        db.close();
        return;
      }
      const stores = [
        'namespace-v2',
        'records-v2',
        'coordination-v2',
        'split-progress-v2',
      ];
      if (stores.some((name) => !db.objectStoreNames.contains(name))) {
        db.close();
        finish(() => reject(new Error('coordinated IndexedDB protocol is incomplete')));
        return;
      }
      let abortReason: Error | null = null;
      const tx = db.transaction(stores, 'readwrite');
      const abort = (reason: Error): void => {
        if (abortReason) return;
        abortReason = reason;
        try {
          tx.abort();
        } catch {
          /* transaction may already be inactive */
        }
      };
      const namespaceStore = tx.objectStore('namespace-v2');
      const coordinationStore = tx.objectStore('coordination-v2');
      const recordsStore = tx.objectStore('records-v2');
      const bindingRequest = namespaceStore.get('offline-v2');
      bindingRequest.onerror = () => abort(
        bindingRequest.error ?? new Error('coordinated namespace read failed'),
      );
      bindingRequest.onsuccess = () => {
        const binding = bindingRequest.result as {
          resource?: unknown;
          protocolVersion?: unknown;
          namespace?: unknown;
        } | undefined;
        if (
          binding?.resource !== 'offline-v2'
          || binding.protocolVersion !== 2
          || binding.namespace !== namespace
        ) {
          abort(new Error('coordinated IndexedDB namespace does not match purge request'));
          return;
        }
        const leaderRequest = coordinationStore.get(namespace);
        leaderRequest.onerror = () => abort(
          leaderRequest.error ?? new Error('coordinated leadership read failed'),
        );
        leaderRequest.onsuccess = () => {
          const leader = leaderRequest.result as { leaseUntil?: unknown } | undefined;
          if (typeof leader?.leaseUntil === 'number' && leader.leaseUntil > now) {
            abort(new Error('coordinated IndexedDB still has an active leader'));
            return;
          }
          const cursorRequest = recordsStore.openCursor();
          cursorRequest.onerror = () => abort(
            cursorRequest.error ?? new Error('coordinated lease scan failed'),
          );
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              recordsStore.clear();
              coordinationStore.clear();
              tx.objectStore('split-progress-v2').clear();
              return;
            }
            const record = cursor.value as { state?: unknown; leaseUntil?: unknown };
            if (
              record?.state === 'leased'
              && typeof record.leaseUntil === 'number'
              && record.leaseUntil > now
            ) {
              abort(new Error('coordinated IndexedDB still has an active record lease'));
              return;
            }
            cursor.continue();
          };
        };
      };
      tx.oncomplete = () => {
        db.close();
        finish(() => resolve(true));
      };
      tx.onabort = () => {
        db.close();
        finish(() => reject(
          abortReason ?? tx.error ?? new Error('coordinated IndexedDB purge aborted'),
        ));
      };
      tx.onerror = () => {
        // onabort is the single rejection boundary.
      };
    };
  });
}

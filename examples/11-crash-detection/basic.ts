import { AemeathLogger } from 'aemeath-js/core/Logger';
import { UploadPlugin, classifyHttpUploadResponse } from 'aemeath-js/plugins/UploadPlugin';
import { OfflinePersistencePlugin } from 'aemeath-js/plugins/OfflinePersistencePlugin';
import { SafeGuardPlugin } from 'aemeath-js/plugins/SafeGuardPlugin';
import { PayloadSanitizePlugin } from 'aemeath-js/plugins/PayloadSanitizePlugin';
import { BeforeSendPlugin } from 'aemeath-js/plugins/BeforeSendPlugin';
import { CrashDetectionPlugin } from 'aemeath-js/plugins/CrashDetectionPlugin';

export function startCrashExample() {
  const logger = new AemeathLogger({ release: 'web-2026.10', enableConsole: false });
  logger.use(new SafeGuardPlugin());
  logger.use(new UploadPlugin({
    deliveryScope: 'shop-production',
    cache: { key: 'shop-production-upload' },
    onUpload: async log => {
      try {
        const response = await fetch('/api/logs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log),
        });
        return classifyHttpUploadResponse(response.status, response.headers.get('Retry-After'));
      } catch { return { success: false, retryReason: 'network' }; }
    },
  }));
  logger.use(new OfflinePersistencePlugin({ dbName: 'shop-production-offline', key: 'shop-production-offline' }));
  logger.use(new PayloadSanitizePlugin());
  logger.use(new BeforeSendPlugin({ beforeSend: entry => entry }));

  const crash = new CrashDetectionPlugin({
    namespace: 'shop-production-crash',
    deliveryScope: 'shop-production',
    createWorker: () => new Worker(new URL('./crash.worker.ts', import.meta.url), { type: 'module' }),
    checkpoint: { collect: () => ({ routeKey: 'checkout', operation: { name: 'payment', phase: 'pending' } }) },
  });
  logger.use(crash);
  void crash.ready().then(status => { if (status.state === 'active') crash.addBreadcrumb({ name: 'checkout-opened' }); });
  // Teardown: logger.uninstall('crash-detection');
  // Consent withdrawal: await crash.clearStoredData(); then uninstall the plugin.
  return { logger, crash };
}

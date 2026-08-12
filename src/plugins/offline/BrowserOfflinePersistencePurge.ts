import type { AemeathInterface } from '../../types';
import {
  purgeOfflinePersistenceStorageWithHook,
  type OfflinePersistencePurgeOptions,
} from '../OfflinePersistencePlugin';
import { clearDormantCoordinatedDatabase } from './OfflineProtocol';

/**
 * 浏览器入口的完整清盘：legacy 与可选跨标签数据库共用一个资源栅栏。
 * 小程序入口只调用 legacy 版本，因此不会把 v2 IDB 协议打进小程序包。
 */
export function purgeBrowserOfflinePersistenceStorage(
  platform: AemeathInterface['platform'],
  options: OfflinePersistencePurgeOptions = {},
): Promise<void> {
  return purgeOfflinePersistenceStorageWithHook(
    platform,
    options,
    async ({ dbName, namespace, storage, canPurgeCrossTabStorage }) => {
      if (storage === 'localstorage' || !canPurgeCrossTabStorage) return;
      try {
        if (typeof indexedDB === 'undefined' || indexedDB === null) return;
      } catch {
        return;
      }
      await clearDormantCoordinatedDatabase(dbName, namespace);
    },
  );
}

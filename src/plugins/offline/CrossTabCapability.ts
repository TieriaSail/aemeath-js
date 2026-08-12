import type { AemeathInterface } from '../../types';
import type {
  OfflineCrossTabCoordinationFactory,
  OfflineCrossTabStoreFactory,
} from '../OfflinePersistencePlugin';

/**
 * 跨标签交付的内部能力标识。
 *
 * 插件名是公开且可复用的字符串，不能作为安全的功能开关。唯一 symbol 让默认
 * Upload/Offline 路径只识别 SDK 自带插件实例，也不会把协调实现带入核心模块。
 */
export const CROSS_TAB_DELIVERY_CAPABILITY: unique symbol = Symbol.for(
  'aemeath.cross-tab-delivery.capability.v2',
);

export interface CrossTabDeliveryCapability {
  readonly createStore: OfflineCrossTabStoreFactory;
  /**
   * 与 createStore 成对提供，确保 OfflinePersistence 不需要运行时导入 v2
   * 协调实现。默认入口和小程序入口因此不会被多标签事务代码侵入。
   */
  readonly createCoordination: OfflineCrossTabCoordinationFactory;
  readonly namespace?: string;
}

type CrossTabDeliveryCapabilityHost = {
  readonly [CROSS_TAB_DELIVERY_CAPABILITY]?: CrossTabDeliveryCapability;
};

export function getCrossTabDeliveryCapability(
  logger: AemeathInterface | null | undefined,
): CrossTabDeliveryCapability | null {
  if (!logger) return null;
  const plugin = logger.getPluginInstance('cross-tab-delivery') as
    CrossTabDeliveryCapabilityHost | undefined;
  const capability = plugin?.[CROSS_TAB_DELIVERY_CAPABILITY];
  return capability &&
    typeof capability.createStore === 'function' &&
    typeof capability.createCoordination === 'function'
    ? capability
    : null;
}

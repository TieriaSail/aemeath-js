/**
 * e2e 测试用的浏览器入口
 *
 * 把 npm 入口（initAemeath）的完整能力挂到 window 上。CDN 的 IIFE 产物
 * 不导出 OfflinePersistencePlugin，而 2.5 的可靠性改动大半在那里，
 * 所以真实浏览器测试必须走这个包，不能用 dist 的 global.js。
 */
import {
  initAemeath,
  getAemeath,
  resetAemeath,
  isAemeathInitialized,
  setBeforeSend,
  AemeathLogger,
  OfflinePersistencePlugin,
  UploadPlugin,
  PayloadSanitizePlugin,
} from '../../src/index';

declare global {
  interface Window {
    __aemeath__: typeof harness;
  }
}

const harness = {
  initAemeath,
  getAemeath,
  resetAemeath,
  isAemeathInitialized,
  setBeforeSend,
  AemeathLogger,
  OfflinePersistencePlugin,
  UploadPlugin,
  PayloadSanitizePlugin,
};

window.__aemeath__ = harness;

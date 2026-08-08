/**
 * 上报期间的网络捕获忽略窗口
 *
 * UploadPlugin 调用用户的 `onUpload` 时，回调里几乎总会发起 fetch / XHR /
 * wx.request。若 NetworkPlugin 把这些请求再记成一条日志，就会：
 *   业务日志 → 上报 → 记成 network.success → 再上报 → …
 * 在真实浏览器里这是一个不收敛的自反馈环（见 e2e/self-traffic.spec.ts）。
 *
 * URL 黑名单解不了：`onUpload` 是不透明回调，SDK 拿不到上报地址。
 * 正确做法是在回调执行期间（含其 await 的异步）抬高引用计数，插桩层
 * 在请求**发起时**看到计数 > 0 就原样放行、不记录。
 *
 * 与 `ignoreNextOnError` 同套路：模块级计数、可重入、测试可复位。
 */

let _ignoreNetworkCapture = 0;

/** 当前是否处于「不要记录网络请求」窗口内 */
export function shouldIgnoreNetworkCapture(): boolean {
  return _ignoreNetworkCapture > 0;
}

/** 抬高忽略计数（可重入）。必须与 `endIgnoreNetworkCapture` 成对。 */
export function beginIgnoreNetworkCapture(): void {
  _ignoreNetworkCapture++;
}

/** 降低忽略计数（下限 0）。 */
export function endIgnoreNetworkCapture(): void {
  _ignoreNetworkCapture = Math.max(0, _ignoreNetworkCapture - 1);
}

/**
 * 在忽略窗口内执行 `fn`（同步或返回 Promise 均可）
 *
 * 窗口覆盖 `fn` 同步体及其 await 到 settle 的整段时间；嵌套调用用引用计数，
 * 并发上报也不会提前揭开窗口。
 *
 * 若调用方需要把窗口与 `Promise.race` 超时对齐（超时后立刻揭开、不绑死在
 * 仍挂起的 `onUpload` 上），请改用 `beginIgnoreNetworkCapture` /
 * `endIgnoreNetworkCapture`。
 */
export function runWithoutNetworkCapture<T>(fn: () => T | Promise<T>): Promise<T> {
  beginIgnoreNetworkCapture();
  try {
    return Promise.resolve(fn()).finally(() => {
      endIgnoreNetworkCapture();
    });
  } catch (error) {
    // 同步抛出时 finally 不会跑到（Promise.resolve 都没建起来）
    endIgnoreNetworkCapture();
    return Promise.reject(error);
  }
}

/**
 * 复位忽略计数。仅测试用。
 * @internal
 */
export function _resetIgnoreNetworkCapture(): void {
  _ignoreNetworkCapture = 0;
}

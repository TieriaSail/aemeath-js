/**
 * 全局上下文示例
 *
 * 适用场景：
 * - 用户标识（userId, deviceId）
 * - 设备信息（platform, os, browser）
 * - 应用信息（appVersion, buildNumber）
 * - 网络信息（ip, region）
 * - 其他需要附加到每条日志的通用信息
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { initAemeath, getAemeath } from 'aemeath-js';

// ==================== 示例 1: 基础用法 ====================

// 在应用入口配置全局上下文
initAemeath({
  upload: async (log) => {
    await fetch('/api/logs', {
      method: 'POST',
      body: JSON.stringify(log),
    });
  },
  context: {
    userId: '12345',
    deviceId: 'abc-def-123',
    appVersion: '1.0.0',
    platform: 'iOS',
    buildNumber: '100',
  },
});

// 在任何地方记录日志
const logger = getAemeath();
logger.info('User action'); // 自动附加 context

// 输出示例：
// {
//   level: 'info',
//   message: 'User action',
//   timestamp: 1703123456789,
//   context: {
//     userId: '12345',
//     deviceId: 'abc-def-123',
//     appVersion: '1.0.0',
//     platform: 'iOS',
//     buildNumber: '100'
//   }
// }

// ==================== 示例 2: 动态更新上下文 ====================

// 用户登录后更新 userId
function onUserLogin(userId: string) {
  const logger = getAemeath();
  logger.updateContext({ userId });
  logger.info('User logged in');
}

// 切换设备后更新 deviceId
function onDeviceChange(deviceId: string) {
  const logger = getAemeath();
  logger.updateContext({ deviceId });
  logger.info('Device changed');
}

// 应用升级后更新版本
function onAppUpgrade(newVersion: string) {
  const logger = getAemeath();
  logger.updateContext({ appVersion: newVersion });
  logger.info('App upgraded');
}

// ==================== 示例 3: 完全替换上下文 ====================

// 用户登出时清空用户相关信息
function onUserLogout() {
  const logger = getAemeath();

  // 获取当前上下文
  const currentContext = logger.getContext();

  // 保留设备信息，移除用户信息
  logger.setContext({
    deviceId: currentContext.deviceId,
    appVersion: currentContext.appVersion,
    platform: currentContext.platform,
    // userId 被移除
  });

  logger.info('User logged out');
}

// ==================== 示例 4: 清空上下文 ====================

// 测试或重置时清空所有上下文
function resetContext() {
  const logger = getAemeath();
  logger.clearContext();
  logger.info('Context cleared');
}

// ==================== 示例 5: 实际应用场景 ====================

// App.tsx
import { initAemeath, getAemeath } from 'aemeath-js';
import { getDeviceInfo, getUserInfo, getNetworkInfo } from './utils';

// 应用启动时初始化
function initApp() {
  const deviceInfo = getDeviceInfo();
  const networkInfo = getNetworkInfo();

  initAemeath({
    upload: async (log) => {
      await fetch('/api/logs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify(log),
      });
    },
    context: {
      // 设备信息
      deviceId: deviceInfo.id,
      platform: deviceInfo.platform,
      os: deviceInfo.os,
      browser: deviceInfo.browser,

      // 应用信息
      appVersion: process.env.APP_VERSION,
      buildNumber: process.env.BUILD_NUMBER,
      environment: process.env.NODE_ENV,

      // 网络信息
      ip: networkInfo.ip,
      region: networkInfo.region,
    },
  });
}

// 用户登录后更新上下文
function handleLogin(user: any) {
  const logger = getAemeath();
  logger.updateContext({
    userId: user.id,
    username: user.name,
    email: user.email,
    role: user.role,
  });

  logger.info('User logged in successfully');
}

// 页面访问时记录
function trackPageView(pageName: string) {
  const logger = getAemeath();
  logger.info('Page viewed', { pageName });
  // context 会自动附加：userId, deviceId, appVersion 等
}

// 错误发生时记录
function handleError(error: Error) {
  const logger = getAemeath();
  logger.error('Application error', error);
  // context 会自动附加，帮助定位问题
}

// ==================== 示例 6: 与 extra 的区别 ====================

const logger6 = getAemeath();

// context: 全局的、持久的、所有日志都需要的信息
logger6.setContext({
  userId: '12345',
  deviceId: 'abc',
  appVersion: '1.0.0',
});

// extra: 单次日志特定的、临时的信息
logger6.info('Button clicked', {
  buttonId: 'submit',
  clickCount: 1,
  timestamp: Date.now(),
});

// 输出：
// {
//   level: 'info',
//   message: 'Button clicked',
//   context: {           // 全局的
//     userId: '12345',
//     deviceId: 'abc',
//     appVersion: '1.0.0'
//   },
//   extra: {             // 单次特定的
//     buttonId: 'submit',
//     clickCount: 1,
//     timestamp: 1703123456789
//   }
// }

/**
 * PerformancePlugin - 自定义性能测量
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { AemeathLogger, PerformancePlugin } from 'aemeath-js';

const logger = new AemeathLogger();
logger.use(new PerformancePlugin());

// ==================== 示例1: 测量函数执行时间 ====================

async function fetchUserData(userId: string) {
  logger.startMark('fetch-user-data');

  try {
    const response = await fetch(`/api/users/${userId}`);
    const data = await response.json();

    const duration = logger.endMark('fetch-user-data');
    console.log(`获取用户数据耗时: ${duration}ms`);

    return data;
  } catch (error) {
    logger.endMark('fetch-user-data');
    throw error;
  }
}

// ==================== 示例2: React 组件渲染时间 ====================

// import { useEffect } from 'react';
//
// function UserProfile({ userId }: { userId: string }) {
//   useEffect(() => {
//     logger.startMark('user-profile-render');
//
//     return () => {
//       logger.endMark('user-profile-render');
//     };
//   }, []);
//
//   return <div>User Profile</div>;
// }

// ==================== 示例3: 复杂操作的多个阶段 ====================

async function complexOperation() {
  // 阶段1: 数据获取
  logger.startMark('stage-1-fetch');
  const data = await fetchData();
  logger.endMark('stage-1-fetch');

  // 阶段2: 数据处理
  logger.startMark('stage-2-process');
  const processed = processData(data);
  logger.endMark('stage-2-process');

  // 阶段3: 渲染
  logger.startMark('stage-3-render');
  renderData(processed);
  logger.endMark('stage-3-render');
}

// ==================== 示例4: 使用原生 Performance API ====================

function measureWithNativeAPI() {
  // 开始标记
  performance.mark('operation-start');

  // ... 执行操作 ...

  // 结束标记
  performance.mark('operation-end');

  // 测量并记录
  logger.measure('my-operation', 'operation-start', 'operation-end');
}

// ==================== 示例5: 条件测量（只在慢时记录） ====================

async function fetchDataWithThreshold() {
  const startTime = Date.now();

  const data = await fetch('/api/data');

  const duration = Date.now() - startTime;

  // 只记录慢请求（>1000ms）
  if (duration > 1000) {
    logger.warn('慢请求', {
      context: { url: '/api/data', duration },
    });
  }

  return data;
}

// ==================== 示例6: 批量测量 ====================

class PerformanceTracker {
  private marks = new Map<string, number>();

  start(name: string) {
    this.marks.set(name, Date.now());
    logger.startMark(name);
  }

  end(name: string): number | null {
    const startTime = this.marks.get(name);
    if (!startTime) return null;

    const duration = Date.now() - startTime;
    this.marks.delete(name);
    logger.endMark(name);

    return duration;
  }

  endAll() {
    const results: Record<string, number> = {};

    for (const [name] of this.marks) {
      const duration = this.end(name);
      if (duration !== null) {
        results[name] = duration;
      }
    }

    return results;
  }
}

// 使用
const tracker = new PerformanceTracker();

tracker.start('init');
tracker.start('load-config');
tracker.start('connect-db');

// ... 执行操作 ...

tracker.end('connect-db');
tracker.end('load-config');
tracker.end('init');

export { logger, fetchUserData, UserProfile, PerformanceTracker };

/**
 * React 集成模块测试
 *
 * 测试内容：
 * - AemeathErrorBoundary 组件
 * - useAemeath Hook
 * - useErrorCapture Hook
 * - withErrorBoundary HOC
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  AemeathErrorBoundary,
  useAemeath,
  useErrorCapture,
  withErrorBoundary,
  AemeathContext,
} from '../../integrations/react';
import { AemeathLogger } from '../../core/Logger';
import * as singletonModule from '../../singleton';

// ==================== 辅助组件 ====================

// 正常渲染的组件
function GoodComponent() {
  return <div>正常内容</div>;
}

// 故意抛错的组件
function BrokenComponent(): React.ReactNode {
  throw new Error('组件崩溃了');
}

// 使用 useAemeath 的组件
function LoggerConsumer() {
  const logger = useAemeath();
  return (
    <div>
      <span data-testid="has-logger">{logger ? 'yes' : 'no'}</span>
      <button onClick={() => logger.info('clicked')}>Log</button>
    </div>
  );
}

// 使用 useErrorCapture 的组件
function ErrorCaptureConsumer() {
  const { captureError, captureMessage } = useErrorCapture();
  return (
    <div>
      <button
        data-testid="capture-error"
        onClick={() => captureError(new Error('手动捕获'), { action: 'test' })}
      >
        Capture Error
      </button>
      <button
        data-testid="capture-message"
        onClick={() => captureMessage('测试消息', 'warn', { source: 'test' })}
      >
        Capture Message
      </button>
    </div>
  );
}

// ==================== 测试 ====================

describe('React Integration', () => {
  let logger: AemeathLogger;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new AemeathLogger({ enableConsole: false });
    logSpy = vi.fn();
    logger.on('log', logSpy);

    // Mock getAemeath 以返回我们的测试 logger
    vi.spyOn(singletonModule, 'getAemeath').mockReturnValue(logger);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==================== AemeathErrorBoundary ====================

  describe('AemeathErrorBoundary', () => {
    // 抑制 React 在 ErrorBoundary 触发时的 console.error 输出
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('子组件正常时应正常渲染', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <GoodComponent />
        </AemeathErrorBoundary>,
      );
      expect(screen.getByText('正常内容')).toBeDefined();
    });

    it('子组件崩溃时应渲染 ReactNode fallback', () => {
      render(
        <AemeathErrorBoundary logger={logger} fallback={<div>出错了</div>}>
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      expect(screen.getByText('出错了')).toBeDefined();
    });

    it('子组件崩溃时应渲染 function fallback 并提供 reset', () => {
      render(
        <AemeathErrorBoundary
          logger={logger}
          fallback={(error, reset) => (
            <div>
              <span>错误: {error.message}</span>
              <button onClick={reset}>重试</button>
            </div>
          )}
        >
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      expect(screen.getByText('错误: 组件崩溃了')).toBeDefined();
      expect(screen.getByText('重试')).toBeDefined();
    });

    it('崩溃时应自动上报错误到 Logger', () => {
      render(
        <AemeathErrorBoundary logger={logger} fallback={<div>出错了</div>}>
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      // 验证 logger.error 被调用
      expect(logSpy).toHaveBeenCalled();
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('error');
      expect(logEntry.message).toBe('React component error');
      expect(logEntry.tags?.errorCategory).toBe('react');
      expect(logEntry.tags?.component).toBe('ErrorBoundary');
      expect(logEntry.context?.componentStack).toBeDefined();
    });

    it('崩溃时应调用 onError 回调', () => {
      const onError = vi.fn();

      render(
        <AemeathErrorBoundary
          logger={logger}
          fallback={<div>出错了</div>}
          onError={onError}
        >
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ componentStack: expect.any(String) }),
      );
    });

    it('无 fallback 时应显示默认错误 UI', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      expect(screen.getByText('Something went wrong')).toBeDefined();
      expect(screen.getByText('Try again')).toBeDefined();
    });

    it('未传 logger 时应使用全局单例', () => {
      render(
        <AemeathErrorBoundary fallback={<div>出错了</div>}>
          <BrokenComponent />
        </AemeathErrorBoundary>,
      );

      // getAemeath 被调用（因为没传 logger prop）
      expect(singletonModule.getAemeath).toHaveBeenCalled();
      // 错误仍然被记录
      expect(logSpy).toHaveBeenCalled();
    });

    it('正常渲染时应通过 Context 提供 Logger', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <LoggerConsumer />
        </AemeathErrorBoundary>,
      );

      expect(screen.getByTestId('has-logger').textContent).toBe('yes');
    });
  });

  // ==================== useAemeath ====================

  describe('useAemeath', () => {
    it('在 ErrorBoundary 内应获取到 Context 中的 Logger', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <LoggerConsumer />
        </AemeathErrorBoundary>,
      );

      // 点击按钮触发日志
      fireEvent.click(screen.getByText('Log'));
      expect(logSpy).toHaveBeenCalled();
      expect(logSpy.mock.calls[0][0].message).toBe('clicked');
    });

    it('在 ErrorBoundary 外应使用全局单例', () => {
      render(<LoggerConsumer />);

      expect(screen.getByTestId('has-logger').textContent).toBe('yes');
      // getAemeath 被调用（因为不在 ErrorBoundary 内）
      expect(singletonModule.getAemeath).toHaveBeenCalled();
    });
  });

  // ==================== useErrorCapture ====================

  describe('useErrorCapture', () => {
    it('captureError 应上报错误', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <ErrorCaptureConsumer />
        </AemeathErrorBoundary>,
      );

      fireEvent.click(screen.getByTestId('capture-error'));

      expect(logSpy).toHaveBeenCalled();
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('error');
      expect(logEntry.message).toBe('手动捕获');
      expect(logEntry.tags?.errorCategory).toBe('react');
      expect(logEntry.tags?.source).toBe('useErrorCapture');
      expect(logEntry.tags?.action).toBe('test');
    });

    it('captureMessage 应上报指定级别消息', () => {
      render(
        <AemeathErrorBoundary logger={logger}>
          <ErrorCaptureConsumer />
        </AemeathErrorBoundary>,
      );

      fireEvent.click(screen.getByTestId('capture-message'));

      expect(logSpy).toHaveBeenCalled();
      const logEntry = logSpy.mock.calls[0][0];
      expect(logEntry.level).toBe('warn');
      expect(logEntry.message).toBe('测试消息');
      // extra 中的 source: 'test' 覆盖了默认的 source: 'useErrorCapture'
      expect(logEntry.tags?.source).toBe('test');
    });
  });

  // ==================== withErrorBoundary HOC ====================

  describe('withErrorBoundary', () => {
    it('应包裹组件并提供错误边界', () => {
      // 先抑制 console.error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const SafeBroken = withErrorBoundary(BrokenComponent, {
        logger,
        fallback: <div>HOC 捕获到错误</div>,
      });

      render(<SafeBroken />);
      expect(screen.getByText('HOC 捕获到错误')).toBeDefined();
      expect(logSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('应设置正确的 displayName', () => {
      const SafeGood = withErrorBoundary(GoodComponent, { logger });
      expect(SafeGood.displayName).toBe('withErrorBoundary(GoodComponent)');
    });

    it('正常组件应正常渲染', () => {
      const SafeGood = withErrorBoundary(GoodComponent, { logger });
      render(<SafeGood />);
      expect(screen.getByText('正常内容')).toBeDefined();
    });
  });
});


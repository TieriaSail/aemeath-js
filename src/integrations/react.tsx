/**
 * React 框架集成
 *
 * 提供 React 特定的错误捕获能力：
 * - Error Boundary 组件
 * - useAemeath Hook
 *
 * 使用方式：
 * ```tsx
 * import { AemeathErrorBoundary, useAemeath } from 'aemeath-js/react';
 *
 * // 1. 包裹应用
 * <AemeathErrorBoundary fallback={<ErrorPage />}>
 *   <App />
 * </AemeathErrorBoundary>
 *
 * // 2. 在组件中使用
 * const logger = useAemeath();
 * logger.info('Component mounted');
 * ```
 */

import React, {
  Component,
  createContext,
  useContext,
  useCallback,
  type ReactNode,
  type ErrorInfo as ReactErrorInfo,
} from 'react';
import type { AemeathLogger } from '../core/Logger';
import { getAemeath } from '../singleton';

// ==================== Context ====================

const AemeathContext = createContext<AemeathLogger | null>(null);

// ==================== Error Boundary ====================

export interface AemeathErrorBoundaryProps {
  /**
   * 子组件
   */
  children: ReactNode;

  /**
   * 错误时显示的回退 UI
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);

  /**
   * 自定义 AemeathJs 实例（可选，默认使用全局单例）
   */
  logger?: AemeathLogger;

  /**
   * 错误回调（可选）
   */
  onError?: (error: Error, errorInfo: ReactErrorInfo) => void;

  /**
   * 是否在开发环境显示错误详情
   * @default true
   */
  showErrorDetails?: boolean;
}

interface AemeathErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Aemeath Error Boundary
 *
 * 捕获 React 组件树中的错误，并自动上报到 AemeathJs
 *
 * @example
 * ```tsx
 * // 基础用法
 * <AemeathErrorBoundary fallback={<div>出错了</div>}>
 *   <App />
 * </AemeathErrorBoundary>
 *
 * // 带重置功能
 * <AemeathErrorBoundary
 *   fallback={(error, reset) => (
 *     <div>
 *       <p>出错了: {error.message}</p>
 *       <button onClick={reset}>重试</button>
 *     </div>
 *   )}
 * >
 *   <App />
 * </AemeathErrorBoundary>
 * ```
 */
export class AemeathErrorBoundary extends Component<
  AemeathErrorBoundaryProps,
  AemeathErrorBoundaryState
> {
  private logger: AemeathLogger;

  constructor(props: AemeathErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
    this.logger = props.logger || getAemeath();
  }

  static getDerivedStateFromError(error: Error): AemeathErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ReactErrorInfo): void {
    // 上报错误到 AemeathJs
    const enhancedError = error as Error & {
      componentStack?: string;
      isReactError?: boolean;
    };
    enhancedError.componentStack = errorInfo.componentStack || undefined;
    enhancedError.isReactError = true;

    this.logger.error('React component error', {
      error: enhancedError,
      tags: {
        errorCategory: 'react',
        component: 'ErrorBoundary',
      },
      context: {
        componentStack: errorInfo.componentStack,
      },
    });

    try {
      this.props.onError?.(error, errorInfo);
    } catch {
      // prevent user callback error from crashing ErrorBoundary
    }
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  override render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback, showErrorDetails = true } = this.props;

    if (hasError && error) {
      // 渲染回退 UI
      if (typeof fallback === 'function') {
        return fallback(error, this.reset);
      }

      if (fallback) {
        return fallback;
      }

      // 默认回退 UI
      return (
        <div
          style={{
            padding: '20px',
            background: '#fff3f3',
            border: '1px solid #ff4d4f',
            borderRadius: '4px',
            margin: '10px',
          }}
        >
          <h3 style={{ color: '#ff4d4f', margin: '0 0 10px' }}>
            Something went wrong
          </h3>
          {showErrorDetails && process.env.NODE_ENV === 'development' && (
            <pre
              style={{
                background: '#f5f5f5',
                padding: '10px',
                overflow: 'auto',
                fontSize: '12px',
              }}
            >
              {error.message}
              {'\n'}
              {error.stack}
            </pre>
          )}
          <button
            onClick={this.reset}
            style={{
              marginTop: '10px',
              padding: '8px 16px',
              background: '#1890ff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <AemeathContext.Provider value={this.logger}>
        {children}
      </AemeathContext.Provider>
    );
  }
}

// ==================== Hooks ====================

/**
 * 获取 AemeathJs 实例的 Hook
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const logger = useAemeath();
 *
 *   useEffect(() => {
 *     logger.info('Component mounted');
 *   }, []);
 *
 *   return <div>...</div>;
 * }
 * ```
 */
export function useAemeath(): AemeathLogger {
  const contextLogger = useContext(AemeathContext);
  // 如果在 ErrorBoundary 外使用，返回全局单例
  return contextLogger || getAemeath();
}

/**
 * 错误上报 Hook
 *
 * 用于手动捕获和上报错误
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { captureError, captureMessage } = useErrorCapture();
 *
 *   const handleClick = async () => {
 *     try {
 *       await riskyOperation();
 *     } catch (error) {
 *       captureError(error as Error, { action: 'risky-operation' });
 *     }
 *   };
 *
 *   return <button onClick={handleClick}>Do something</button>;
 * }
 * ```
 */
export function useErrorCapture() {
  const logger = useAemeath();

  const captureError = useCallback(
    (error: Error, extra?: Record<string, unknown>) => {
      logger.error(error.message, {
        error,
        tags: {
          errorCategory: 'react',
          source: 'useErrorCapture',
          ...extra,
        },
      });
    },
    [logger],
  );

  const captureMessage = useCallback(
    (
      message: string,
      level: 'info' | 'warn' | 'error' = 'info',
      extra?: Record<string, unknown>,
    ) => {
      logger[level](message, {
        tags: {
          source: 'useErrorCapture',
          ...extra,
        },
      });
    },
    [logger],
  );

  return { captureError, captureMessage, logger };
}

// ==================== HOC ====================

/**
 * 高阶组件：为组件添加错误边界
 *
 * @example
 * ```tsx
 * const SafeComponent = withErrorBoundary(RiskyComponent, {
 *   fallback: <div>Error in component</div>
 * });
 * ```
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  options?: Omit<AemeathErrorBoundaryProps, 'children'>,
): React.FC<P> {
  const displayName =
    WrappedComponent.displayName || WrappedComponent.name || 'Component';

  const WithErrorBoundary: React.FC<P> = (props) => (
    <AemeathErrorBoundary {...options}>
      <WrappedComponent {...props} />
    </AemeathErrorBoundary>
  );

  WithErrorBoundary.displayName = `withErrorBoundary(${displayName})`;

  return WithErrorBoundary;
}

// ==================== 导出 ====================

export { AemeathContext };

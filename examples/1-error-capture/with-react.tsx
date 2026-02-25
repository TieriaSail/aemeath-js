/**
 * 模块1：错误捕获 - React 集成
 *
 * 在 React 项目中捕获错误
 */

import React, { Component, type ReactNode } from 'react';
import { Logger, ErrorCapturePlugin } from 'aemeath-js';

// 创建 logger
const logger = new Logger();
logger.use(new ErrorCapturePlugin());

// ==================== ErrorBoundary 组件 ====================

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // 记录到 logger
    logger.error('React component error', {
      error,
      tags: { component: 'ErrorBoundary', source: 'react' },
      context: {
        react: {
          componentStack: errorInfo.componentStack,
        },
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div
            style={{
              padding: '20px',
              background: '#fee',
              border: '1px solid #f00',
            }}
          >
            <h2>⚠️ 出错了</h2>
            <p>{this.state.error?.message}</p>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

// ==================== 使用示例 ====================

function BuggyComponent() {
  const [count, setCount] = React.useState(0);

  if (count > 3) {
    throw new Error('Count is too high!');
  }

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>Increment</button>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BuggyComponent />
    </ErrorBoundary>
  );
}

// ==================== 使用方式 ====================

/*
// 在 App.tsx 入口处
import { ErrorBoundary } from './examples/1-error-capture/with-react';

function App() {
  return (
    <ErrorBoundary>
      <YourApp />
    </ErrorBoundary>
  );
}
*/

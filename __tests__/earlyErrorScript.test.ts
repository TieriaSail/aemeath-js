/**
 * early-error-script 共享脚本测试
 */
import { describe, it, expect } from 'vitest';
import { getEarlyErrorCaptureScript } from '../src/build-plugins/early-error-script';

describe('getEarlyErrorCaptureScript', () => {
  it('应返回非空字符串', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toBeTruthy();
    expect(typeof script).toBe('string');
  });

  it('应包含 IIFE 结构', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('(function()');
    expect(script).toContain('})()');
  });

  it('应初始化 __EARLY_ERRORS__', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('window.__EARLY_ERRORS__');
  });

  it('应初始化 __LOGGER_INITIALIZED__', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('window.__LOGGER_INITIALIZED__');
  });

  it('应包含 __flushEarlyErrors__ 函数', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('window.__flushEarlyErrors__');
  });

  it('应监听 error 事件', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain("addEventListener('error'");
  });

  it('应监听 unhandledrejection 事件', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain("addEventListener('unhandledrejection'");
  });

  it('应捕获资源加载错误（script/link/img）', () => {
    const script = getEarlyErrorCaptureScript();
    expect(script).toContain('tagName');
    expect(script).toContain("type: 'resource'");
  });

  it('每次调用应返回相同内容', () => {
    const script1 = getEarlyErrorCaptureScript();
    const script2 = getEarlyErrorCaptureScript();
    expect(script1).toBe(script2);
  });
});


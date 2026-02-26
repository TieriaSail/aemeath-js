# 浏览器直接使用（无需构建工具）

适用于 jQuery、原生 JS、静态 HTML 页面等非工程化项目。

## 🚀 快速开始

### 基础用法

```html
<!DOCTYPE html>
<html>
<head>
  <!-- 1. 早期错误捕获（可选，放最前面） -->
  <script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>
  
  <!-- 2. Logger 核心 (~24KB) -->
  <script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
</head>
<body>
  <script>
    // 3. 初始化
    AemeathJs.init({
      upload: function(log) {
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log)
        });
      }
    });
    
    // 4. 使用
    var logger = AemeathJs.getAemeath();
    logger.info('页面加载完成');
  </script>
</body>
</html>
```

---

## 📚 API 参考

### 初始化选项

```javascript
AemeathJs.init({
  // 上报函数（必填）
  upload: function(log) {
    fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
  },
  
  // 是否自动捕获错误（默认 true）
  errorCapture: true,
  
  // 是否启用安全保护（默认 true）
  safeGuard: true,
  
  // 是否输出到控制台（默认 true）
  enableConsole: true,
  
  // 日志级别（默认 'info'）
  level: 'debug' | 'info' | 'warn' | 'error'
});
```

### Logger 方法

```javascript
var logger = AemeathJs.getAemeath();

// 日志级别
logger.debug('调试信息');
logger.info('普通信息');
logger.warn('警告信息');
logger.error('错误信息');

// 带附加数据
logger.info('用户操作', { context: { userId: '123', action: 'click' } });
```

---

## 🔌 jQuery 集成

```html
<script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>
<script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>

<script>
  AemeathJs.init({
    upload: function(log) {
      $.ajax({
        url: '/api/logs',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(log)
      });
    }
  });
  
  var logger = AemeathJs.getAemeath();
  
  // jQuery 事件绑定
  $('#myBtn').click(function() {
    logger.info('按钮被点击', { context: { buttonId: this.id } });
  });
  
  // 全局 AJAX 错误捕获
  $(document).ajaxError(function(event, jqxhr, settings, error) {
    logger.error('AJAX 请求失败', {
      error: error instanceof Error ? error : new Error(String(error)),
      context: { url: settings.url, status: jqxhr.status }
    });
  });
</script>
```

---

## 🌐 CDN 地址

| CDN | Logger 核心 | 早期错误捕获 |
|-----|------------|-------------|
| **unpkg** | `https://unpkg.com/aemeath-js/dist/browser.global.js` | `https://unpkg.com/aemeath-js/scripts/early-error.js` |
| **jsDelivr** | `https://cdn.jsdelivr.net/npm/aemeath-js/dist/browser.global.js` | `https://cdn.jsdelivr.net/npm/aemeath-js/scripts/early-error.js` |

### 指定版本

```html
<!-- 指定版本号 -->
<script src="https://unpkg.com/aemeath-js@1.1.0/dist/browser.global.js"></script>

<!-- 使用最新版本 -->
<script src="https://unpkg.com/aemeath-js/dist/browser.global.js"></script>
```

---

## 💡 注意事项

1. **早期错误捕获脚本必须放在 `<head>` 最前面**，才能捕获页面加载时的错误
2. **Logger 核心可以放在 `<head>` 或 `<body>` 底部**，取决于你的需求
3. **压缩后大小约 24KB**，包含核心功能：错误捕获、安全保护、上报队列
4. **全局变量名为 `AemeathJs`**，避免与其他库冲突

---

## 📖 更多

- [错误捕获](./1-error-capture.md)
- [早期错误捕获](./2-early-error-capture.md)
- [上传插件](./4-upload-plugin.md)


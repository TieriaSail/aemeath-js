# Browser Usage (No Build Tools Required)

For jQuery, vanilla JS, static HTML pages and other non-bundled projects.

## 🚀 Quick Start

### Basic Usage

```html
<!DOCTYPE html>
<html>
<head>
  <!-- 1. Early error capture (optional, place first) -->
  <script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>
  
  <!-- 2. Logger core (~24KB) -->
  <script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
</head>
<body>
  <script>
    // 3. Initialize
    AemeathJs.init({
      upload: function(log) {
        fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(log)
        });
      }
    });
    
    // 4. Use
    var logger = AemeathJs.getAemeath();
    logger.info('Page loaded');
  </script>
</body>
</html>
```

---

## 📚 API Reference

### Initialization Options

```javascript
AemeathJs.init({
  // Upload function (required)
  upload: function(log) {
    fetch('/api/logs', { method: 'POST', body: JSON.stringify(log) });
  },
  
  // Auto capture errors (default: true)
  errorCapture: true,
  
  // Enable safeguard (default: true)
  safeGuard: true,
  
  // Output to console (default: true)
  enableConsole: true,
  
  // Log level (default: 'info')
  level: 'debug' | 'info' | 'track' | 'warn' | 'error'
});
```

### Logger Methods

```javascript
var logger = AemeathJs.getAemeath();

// Log levels
logger.debug('Debug message');
logger.info('Info message');
logger.track('Business event');   // same priority as info, for analytics
logger.warn('Warning message');
logger.error('Error message');

// With additional data
logger.info('User action', { context: { userId: '123', action: 'click' } });
```

---

## 🔌 jQuery Integration

```html
<script src="https://unpkg.com/aemeath-js/scripts/early-error.js"></script>
<script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
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
  
  // jQuery event binding
  $('#myBtn').click(function() {
    logger.info('Button clicked', { context: { buttonId: this.id } });
  });
  
  // Global AJAX error capture
  $(document).ajaxError(function(event, jqxhr, settings, error) {
    logger.error('AJAX request failed', {
      error: error instanceof Error ? error : new Error(String(error)),
      context: { url: settings.url, status: jqxhr.status }
    });
  });
</script>
```

---

## 🌐 CDN URLs

| CDN | Logger Core | Early Error Capture |
|-----|-------------|---------------------|
| **unpkg** | `https://unpkg.com/aemeath-js/dist/aemeath-js.global.js` | `https://unpkg.com/aemeath-js/scripts/early-error.js` |
| **jsDelivr** | `https://cdn.jsdelivr.net/npm/aemeath-js/dist/aemeath-js.global.js` | `https://cdn.jsdelivr.net/npm/aemeath-js/scripts/early-error.js` |

### Specify Version

```html
<!-- Specific version -->
<script src="https://unpkg.com/aemeath-js@1.1.0/dist/aemeath-js.global.js"></script>

<!-- Latest version -->
<script src="https://unpkg.com/aemeath-js/dist/aemeath-js.global.js"></script>
```

---

## 💡 Notes

1. **Early error capture script must be placed at the very beginning of `<head>`** to capture page load errors
2. **Logger core can be placed in `<head>` or at the bottom of `<body>`**, depending on your needs
3. **Minified size is ~24KB**, includes core features: error capture, safeguard, upload queue
4. **Global variable is `AemeathJs`**, avoiding conflicts with other libraries

---

## 📖 More

- [Error Capture](./1-error-capture.md)
- [Early Error Capture](./2-early-error-capture.md)
- [Upload Plugin](./4-upload-plugin.md)


/* 首屏绘制前应用已保存的主题（默认亮色），避免切换闪烁。CSP 只允许同源脚本，所以单独成文件。 */
try { if (localStorage.getItem('mission-control-theme') === 'dark') document.documentElement.dataset.theme = 'dark' } catch {}

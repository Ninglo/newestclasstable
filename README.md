# Newest Class Table

本地运行的班级座位表工具，包含：

- 主页总览与按周轮换
- 文字导入与图片 OCR 导入
- 腾讯 OCR 代理与本地密钥记忆
- 本地一键启动脚本与 macOS 后台服务支持

## Local Run

建议先使用 Node `20.19+` 或 `22.x`。

访问：

- `http://127.0.0.1:5173`

如果需要手动启动：

```bash
npm run ocr:proxy
npm run dev
```

## OCR

腾讯 OCR 代理位于：

- `server/tencent-ocr-server.mjs`

本地密钥示例：

- `server/ocr-credentials.local.example.json`

实际本地密钥文件不会提交：

- `server/ocr-credentials.local.json`

## Desktop Scripts

项目内提供：

- `StartClassTable.command`
- `StopClassTable.command`

## Notes

- 当前图片 OCR 以腾讯 `ExtractDocMulti` 优先
- 本地回退 OCR 可在页面中开启或关闭

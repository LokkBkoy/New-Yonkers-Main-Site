# New Yonkers Vision Media

Cloudflare Worker + R2 media host for KINGX Vision Pro.

Production domain: `https://vision.newyonkers.org`

## Deploy

```bash
npm install
npx wrangler r2 bucket create newyonkers-vision-media
npx wrangler secret put UPLOAD_SHARED_SECRET
npm run deploy
```

Use the exact same secret as the FiveM server convar `kingx_vision_media_secret`. Generate at least 32 random bytes; do not commit it.

## Routes

- `GET /` branded service status page
- `GET /api/health` health check
- `POST /api/upload-session` server-only upload session creation
- `POST /upload/:token` one-time multipart JPEG upload
- `GET /media/:id.jpg` media delivery
- `DELETE /media/:id.jpg` authenticated media deletion

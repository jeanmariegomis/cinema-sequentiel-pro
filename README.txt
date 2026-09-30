CINEMA SEQUENTIEL PRO V12

IMPORTANT: copy server.js to the project root and copy BOTH files inside public/:
- public/index.html
- public/login.html

V12 changes:
- server-side web authentication gate: unauthenticated visitors receive login.html at /
- after successful login, the server serves public/index.html
- API routes remain protected by csp_auth
- no Agnes API key is requested in the browser
- index.html uses server authentication for the Generate button
- fixed /api/jobs request

Render environment variables to preserve:
APP_PASSWORD
AUTH_SECRET
AGNES_API_KEY
NODE_ENV=production
Optional: PUBLIC_BASE_URL=https://cinema-sequentiel-pro.onrender.com

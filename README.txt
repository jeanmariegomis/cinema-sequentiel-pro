CINEMA SEQUENTIEL PRO V11 — CORRECTION

1. Remplace server.js par server.js de ce dossier.
2. Remplace package.json par package.json de ce dossier.
3. Conserve dans Render les variables :
   APP_PASSWORD
   AUTH_SECRET
   AGNES_API_KEY
   NODE_ENV=production
4. Optionnel : PUBLIC_BASE_URL=https://cinema-sequentiel-pro.onrender.com
5. Le serveur utilise Agnes :
   POST /v1/videos
   GET  /agnesapi?video_id=...&model_name=agnes-video-v2.0
6. Les scènes sont générées séquentiellement : la scène 2 démarre sur la dernière frame de la scène 1, puis la scène 3 sur la dernière frame de la scène 2.
7. Les références envoyées en data:image sont converties en fichiers publics sur le serveur.
8. 441 frames à 22 fps = environ 20 secondes.

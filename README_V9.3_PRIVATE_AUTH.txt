V9.3 — Authentification privée côté serveur

La page de connexion n'est plus seulement une barrière côté navigateur.
Le serveur vérifie maintenant la session avant les routes de génération.

Variables d'environnement obligatoires :
APP_PASSWORD_SHA256 = SHA-256 du mot de passe choisi
AUTH_SECRET = chaîne aléatoire longue et secrète

Optionnel :
AGNES_API_KEY = clé Agnes AI de secours.

Pour calculer le SHA-256 du mot de passe, utilisez un générateur SHA-256
de confiance ou une commande locale. Ne mettez jamais le mot de passe en clair
dans le code.

La session est conservée par un cookie HttpOnly/Secure pendant 30 jours.
